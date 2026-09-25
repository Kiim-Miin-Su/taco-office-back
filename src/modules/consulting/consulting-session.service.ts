/** @file-guide
 * 목적: consulting-session.service.ts — ConsultingSessionService (service)
 * 책임/재사용: §31 회차 잡기·육하원칙·종료를 한 트랜잭션으로 묶는다 — 시간표·할 일·안내의 **기존 쓰기**를 부르고 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 컨설팅 회차 · 종료 — 테스트 시나리오 I-91 「회차 기록 — 날짜 3개 고르기」 · I-95 「컨설팅 종료」 (C95).
 *
 * 원본 v2 §2 데이터 흐름 「컨설팅 회차를 기록하면 CONS.sess → SER → TODO」가 이 서비스다.
 *   회차 잡기 — 날짜마다 ① `cons_sess` 한 줄(순번은 서버 · 「누가」는 담당 · 학생) ② 그날 그 담당의 컨설팅 회차가 시간표에 있으면 **연결**,
 *              없으면 `ScheduleWriteService.create(…, outer)` 로 하루짜리 회차(겹침은 EXCLUDE 409 → 전부 되돌아간다 · 불가 시간은 응답)
 *              ③ 담당의 할 일 한 줄(`todo.src=consulting`) ④ `cons_event session_added`. 담당이 남이면 알림 한 건.
 *   육하원칙 — 보낸 칸만 바꾼다(C93 PATCH 규약). 다 적으면 그 회차의 할 일을 끝낸 것으로 접는다.
 *   종료     — N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」를 `consultingCloseIssue` 가 판정 → `stage=done` · 앞으로 잡아 둔 회차가 남아 있으면
 *              막는다(접는 사유·처리를 여기서 지어내지 않는다 · 시간표에서 접고 온다) · 학생마다 학부모 안내(PNOTI parent · 문구 틀 `gtpl` 선택 ·
 *              발송처는 N-42) · `cons_event closed` · 담당 알림. 예외 종료(사유·승인)는 N-18-a 가 열려 있어 만들지 않는다.
 * 미리보기는 같은 트랜잭션을 끝까지 돌리고 되돌린다 (C91 · C93 과 같은 모양 · D-R37).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { todayKst } from '../../lib/kst';
import { NOTI_TITLE } from '../../lib/noti';
import { END_MIN, START_MIN, kstDateOf, serStuOn, writtenRows } from '../../lib/sql';
import type { UnavWarnDto } from '../schedule/schedule.dto';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import type { ConsCloseDto, ConsCloseResultDto, ConsSessionCreateDto, ConsSessionPlanRowDto, ConsSessionsResultDto, ConsSessionWriteDto, ConsultingSessionDto } from './consulting.dto';
import { CONSULTING_TYPE_LABEL, consSessDoneSql, consultingCloseIssue, consultingSessionAddIssue, consultingSessionDone, consultingSessionRecorded, type ConsultingType } from './consulting.rules';
import { CONS_SESS_SELECT, ConsultingService, consSessDto } from './consulting.service';

type R = Record<string, unknown>;

class PreviewRollback<T> extends Error {
  constructor(public readonly result: T) { super('preview'); }
}

const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 회차 할 일의 제목 — 잡을 때 만들고, 육하원칙을 다 적으면 같은 제목으로 되찾아 접는다 */
const sessionTodoTitle = (seq: number, studentNames: string[]) => `컨설팅 ${seq}회차 기록 — ${studentNames.join(' · ') || '학생 미정'}`;

/**
 * 「다음까지」 할 일의 제목 앞자락 — 슬라이드 31 연동 「'다음까지' 항목 → TODO 자동 생성 · 담당자에게 NOTI」(31-08).
 * 할 일에는 회차 칸이 없어 **앞자락으로 되찾는다**(회차 기록 할 일과 같은 규약) — 한 회차에 「다음까지」 할 일은 하나다.
 */
const nextUntilTodoPrefix = (seq: number) => `컨설팅 ${seq}회차 다음까지 — `;
const TODO_TITLE_MAX = 160; // todo.title varchar(160)

@Injectable()
export class ConsultingSessionService {
  constructor(
    private readonly ds: DataSource,
    private readonly consulting: ConsultingService,
    private readonly schedule: ScheduleWriteService,
  ) {}

  private async run<T>(preview: boolean, body: (q: QueryRunner) => Promise<T>): Promise<T> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const result = await body(q);
      if (preview) throw new PreviewRollback(result);
      await q.commitTransaction();
      return result;
    } catch (e) {
      await q.rollbackTransaction();
      if (e instanceof PreviewRollback) return e.result as T;
      throw e;
    } finally {
      await q.release();
    }
  }

  private async students(m: EntityManager, consId: number): Promise<Array<{ id: number; name: string }>> {
    const rows = (await m.query(
      `SELECT s.id, s.name FROM cons_stu x JOIN stu s ON s.id = x.student_id WHERE x.cons_id = $1 ORDER BY s.name, s.id`, [consId],
    )) as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name }));
  }

  private async staff(m: EntityManager, id: number): Promise<{ id: number; name: string; active: boolean }> {
    const [st] = (await m.query(`SELECT id, name, active FROM staff WHERE id = $1`, [id])) as Array<{ id: string; name: string; active: boolean }>;
    if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: `구성원 ${id} 을(를) 찾을 수 없습니다` });
    return { id: Number(st.id), name: st.name, active: Boolean(st.active) };
  }

  /* ══ 회차 잡기 — I-91 ═══════════════════════════════════════════════════════════════ */

  addSessions(viewerId: number, canHide: boolean, consId: number, dto: ConsSessionCreateDto, preview: boolean): Promise<ConsSessionsResultDto> {
    return this.run(preview, async (q) => {
      const m = q.manager;
      const c = await this.consulting.lockFull(m, viewerId, canHide, consId);
      const issue = consultingSessionAddIssue(String(c.stage));
      if (issue) throw new ConflictException(issue);
      const staffId = dto.staffId ?? (c.owner_id == null ? null : Number(c.owner_id));
      if (staffId == null) throw new BadRequestException({ code: 'CONS_STAFF_REQUIRED', message: '담당을 고르세요 — 이 건에는 담당이 없습니다' });
      const staff = await this.staff(m, staffId);
      if (!staff.active) throw new BadRequestException({ code: 'STAFF_INACTIVE', message: `${staff.name} 은(는) 활동 중이 아닙니다` });
      const students = await this.students(m, consId);
      const studentNames = students.map((s) => s.name);
      const who = `${staff.name} · ${studentNames.join(' · ')}`;
      const today = todayKst();
      const dates = [...dto.dates].sort();
      const [{ next }] = (await m.query(`SELECT COALESCE(max(seq), 0) + 1 AS next FROM cons_sess WHERE cons_id = $1`, [consId])) as Array<{ next: string }>;
      let seq = Number(next);
      const rows: ConsSessionPlanRowDto[] = [];
      const unavailable: UnavWarnDto[] = [];
      let created = 0;
      let linked = 0;
      for (const date of dates) {
        /* 그날 그 담당의 컨설팅 회차가 이미 시간표에 있으면 — 그 회차다. 새로 만들면 같은 사람·같은 시각이라 EXCLUDE 가 막는다 */
        const [occ] = (await m.query(
          `SELECT s.id, ${START_MIN} AS start_min, ${END_MIN} AS end_min
             FROM ser_occ o JOIN ser s ON s.id = o.ser_id
            WHERE s.kind_key = 'consulting' AND NOT o.canceled AND ${kstDateOf('lower(o.span)')} = $1::date
              AND COALESCE(o.teacher_id, s.teacher_id) = $2
              AND EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id = s.id AND ss.student_id = ANY($3::bigint[]) AND ${serStuOn('ss', '$1::date')})
              AND NOT EXISTS (SELECT 1 FROM cons_sess x WHERE x.ser_id = s.id AND x.on_date = $1::date)
            ORDER BY o.span, s.id LIMIT 1`,
          [date, staff.id, students.map((s) => s.id)],
        )) as Array<{ id: string; start_min: number; end_min: number }>;
        let serId: number;
        let startMin: number;
        let endMin: number;
        if (occ) {
          serId = Number(occ.id); startMin = Number(occ.start_min); endMin = Number(occ.end_min); linked += 1;
        } else {
          if (dto.startMin == null || dto.endMin == null) {
            throw new BadRequestException({ code: 'CONS_SESSION_TIME_REQUIRED', message: `${md(date)} 에는 ${staff.name} 의 컨설팅 회차가 시간표에 없습니다 — 시각을 적어야 새 회차를 만듭니다` });
          }
          try {
            const written = await this.schedule.create({
              kindKey: 'consulting', subKey: await this.subKeyFor(m, String(c.cons_type)), mode: dto.mode ?? 'offline',
              fromDate: date, toDate: date, rrule: 'ONCE', startMin: dto.startMin, endMin: dto.endMin,
              teacherId: staff.id, roomId: dto.roomId ?? null, title: `컨설팅 ${seq}회차`, studentIds: students.map((s) => s.id),
            }, viewerId, q);
            serId = written.serIds[0]!;
            unavailable.push(...written.unavailable);
          } catch (e) {
            // 겹침은 시간표(EXCLUDE · pg 23P01)가 막는다 — **어느 날짜에서** 막혔는지만 문장에 보탠다 (C93 과 같은 자리 · 코드는 필터와 같다)
            const pg = (e as { driverError?: { code?: string; constraint?: string }; code?: string }) ?? {};
            const pgCode = pg.driverError?.code ?? pg.code;
            if (pgCode === '23P01' && (pg.driverError?.constraint ?? '') !== 'stu_pause_no_overlap') {
              throw new ConflictException({
                code: 'RESOURCE_CONFLICT',
                message: `같은 시간에 강사·강의실·줌이 이미 잡혀 있습니다 — 컨설팅 · ${md(date)} ${hhmm(dto.startMin)}–${hhmm(dto.endMin)} · ${staff.name}`,
              });
            }
            throw e;
          }
          startMin = dto.startMin; endMin = dto.endMin; created += 1;
        }
        const [sess] = (await m.query(
          `INSERT INTO cons_sess (cons_id, seq, on_date, who, what, ser_id) VALUES ($1, $2, $3::date, $4, $5, $6) RETURNING id`,
          [consId, seq, date, who, dto.what?.trim() || null, serId],
        )) as Array<{ id: string }>;
        const [todo] = (await m.query(
          `INSERT INTO todo (title, from_id, to_id, due_on, src, cons_id) VALUES ($1, $2, $3, $4::date, 'consulting', $5) RETURNING id`,
          [sessionTodoTitle(seq, studentNames), viewerId, staff.id, date, consId],
        )) as Array<{ id: string }>;
        await m.query(`INSERT INTO cons_event (cons_id, event_type, ref_id, by_id) VALUES ($1, 'session_added', $2, $3)`, [consId, sess.id, viewerId]);
        rows.push({ date, seq, sessId: Number(sess.id), serId, linked: Boolean(occ), startMin, endMin, done: consultingSessionDone(date, today), todoId: Number(todo.id) });
        seq += 1;
      }
      /* 담당이 남이면 한 건 — 첫 날짜의 시간표로 간다 */
      let notified = false;
      if (staff.id !== viewerId) {
        const first = rows[0]!;
        const noti = (await m.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, $4, 'schedule', $5) RETURNING id`,
          [staff.id, viewerId, `컨설팅 회차 ${rows.length}건 잡힘 — ${studentNames.join(' · ')} · ${md(first.date)}${rows.length > 1 ? ` ~ ${md(rows[rows.length - 1]!.date)}` : ''}`, `/schedule?date=${first.date}`, NOTI_TITLE.consSessions],
        )) as Array<{ id: string }>;
        notified = noti.length > 0;
      }
      const [counts] = (await m.query(
        `SELECT (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND ${consSessDoneSql('x', '$2')}) AS done,
                (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND x.on_date > $2::date) AS planned`, [consId, today],
      )) as Array<{ done: number; planned: number }>;
      const sessions = c.sessions == null ? null : Number(c.sessions);
      return {
        preview, consId, staffId: staff.id, staffName: staff.name, studentNames, rows, created, linked,
        sessionsDone: Number(counts?.done ?? 0), sessionsPlanned: Number(counts?.planned ?? 0), sessions,
        overContract: sessions !== null && seq - 1 > sessions,
        unavailable, notified,
      };
    });
  }

  /** 컨설팅 종류 → 과목 키. 시드의 「진학 컨설팅」(admissions)처럼 같은 키의 과목이 있을 때만 — 없으면 null (과목 없는 회차) */
  private async subKeyFor(m: EntityManager, consType: string): Promise<string | null> {
    const [sub] = (await m.query(`SELECT key FROM sub WHERE key = $1`, [consType])) as Array<{ key: string }>;
    return sub ? sub.key : null;
  }

  /* ══ 육하원칙 — 보낸 칸만 ════════════════════════════════════════════════════════════ */

  async writeSession(viewerId: number, canHide: boolean, consId: number, sessId: number, dto: ConsSessionWriteDto): Promise<ConsultingSessionDto> {
    return this.run(false, async (q) => {
      const m = q.manager;
      const c = await this.consulting.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) === 'done') throw new ConflictException({ code: 'CONS_LOCKED', message: '종료된 컨설팅의 회차 기록은 바꿀 수 없습니다' });
      /* 「다음까지」가 바뀌었는지 보려면 고치기 전 값이 필요하다 — 행을 잠그고 읽는다(두 사람이 동시에 적어도 할 일이 둘 서지 않게) */
      const [before] = (await m.query(
        `SELECT id, seq, next_until FROM cons_sess WHERE id = $1 AND cons_id = $2 FOR UPDATE`, [sessId, consId],
      )) as Array<{ id: string; seq: number; next_until: string | null }>;
      if (!before) throw new NotFoundException({ code: 'CONS_SESSION_NOT_FOUND', message: '회차를 찾을 수 없습니다' });
      const sets: string[] = [];
      const params: unknown[] = [sessId, consId];
      /* 칸 이름은 이 고정 목록에서만 온다 — 값은 언제나 파라미터다(주입 없음) */
      const columns = [['who', 'who'], ['what', 'what'], ['why', 'why'], ['how', 'how'], ['result', 'result'], ['nextUntil', 'next_until']] as const;
      for (const [key, column] of columns) {
        if (dto[key] === undefined) continue;
        params.push(dto[key] === null ? null : String(dto[key]).trim() || null);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 칸이 없습니다' });
      await m.query(`UPDATE cons_sess SET ${sets.join(', ')} WHERE id = $1 AND cons_id = $2`, params);
      await m.query(`INSERT INTO cons_event (cons_id, event_type, ref_id, by_id) VALUES ($1, 'session_written', $2, $3)`, [consId, sessId, viewerId]);
      const [r] = (await m.query(`${CONS_SESS_SELECT} WHERE x.id = $1`, [sessId])) as R[];
      const seq = Number(r.seq);
      /* 무엇을·왜·어떻게가 다 적혔으면 그 회차의 할 일은 끝난 것이다 — 제목으로 되찾는다 (할 일에는 회차 칸이 없다). 「기록됨」과 같은 판정이다 */
      if (consultingSessionRecorded({ what: r.what as string | null, why: r.why as string | null, how: r.how as string | null })) {
        await m.query(
          `UPDATE todo SET done = true WHERE cons_id = $1 AND src = 'consulting' AND NOT done AND title LIKE $2`,
          [consId, `컨설팅 ${seq}회차 기록 — %`],
        );
      }
      /* 「다음까지」 (31-08 · 슬라이드 31 연동) — 새로 적히거나 바뀌었을 때만 담당의 할 일 한 줄 + 알림. 기한은 그 뒤 첫 회차 날짜(없으면 없음) */
      const nextUntil = (r.next_until as string | null) ?? null;
      if (dto.nextUntil !== undefined && nextUntil && nextUntil !== (before.next_until ?? null)) {
        await this.nextUntilTodo(m, viewerId, c, consId, seq, (r.on_date as string | null) ?? null, nextUntil);
      }
      return consSessDto(r, todayKst());
    });
  }

  /**
   * 「다음까지」 할 일 — 받는 사람은 건의 담당(owner)이다. 담당이 없으면 적은 사람에게 둔다(할 일을 허공에 두지 않는다).
   * 그 회차의 열린 「다음까지」 할 일이 이미 있으면 제목만 고친다 — 고쳐 적을 때마다 할 일이 쌓이지 않게.
   * 담당이 적은 사람이 아니면 알림 한 건(`etc` · 링크 /consulting).
   */
  private async nextUntilTodo(
    m: EntityManager, viewerId: number, c: R, consId: number, seq: number, onDate: string | null, text: string,
  ): Promise<void> {
    const ownerId = c.owner_id == null ? viewerId : Number(c.owner_id);
    const title = `${nextUntilTodoPrefix(seq)}${text}`.slice(0, TODO_TITLE_MAX);
    /*
     * 기한 = 이 회차 **뒤** 이면서 **오늘이나 그 뒤**인 첫 회차 날짜 (슬라이드 31 「'다음까지'」 · D-R44).
     * 지난 회차를 뒤늦게 적으면 「그 뒤 첫 회차」도 이미 지난 날일 수 있다 — 그 날을 기한으로 두면 할 일이
     * **태어나자마자 기한 지남**이 된다(qa-w3 관찰 · 운영 배지 +1). 할 일은 지금 생기므로 「다음」은 아직 오지 않은 다음 만남이다.
     * 앞으로 잡힌 회차가 없으면 기한 없음(지어내지 않는다).
     */
    const [nextSess] = (await m.query(
      `SELECT to_char(min(on_date),'YYYY-MM-DD') AS on_date FROM cons_sess
        WHERE cons_id = $1 AND on_date > COALESCE($2::date, '-infinity'::date) AND on_date >= $3::date`,
      [consId, onDate, todayKst()],
    )) as Array<{ on_date: string | null }>;
    const dueOn = nextSess?.on_date ?? null;
    const updated = writtenRows<{ id: string }>(await m.query(
      `UPDATE todo SET title = $3, due_on = $4::date
        WHERE cons_id = $1 AND src = 'consulting' AND NOT done AND title LIKE $2 RETURNING id`,
      [consId, `${nextUntilTodoPrefix(seq)}%`, title, dueOn],
    ));
    if (updated.length === 0) {
      await m.query(
        `INSERT INTO todo (title, from_id, to_id, due_on, src, cons_id) VALUES ($1, $2, $3, $4::date, 'consulting', $5)`,
        [title, viewerId, ownerId, dueOn, consId],
      );
    }
    if (ownerId !== viewerId) {
      const students = await this.students(m, consId);
      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title) SELECT $1, $2, $3, '/consulting', 'etc', $4 FROM staff WHERE id = $1 AND active`,
        [ownerId, viewerId, `컨설팅 ${seq}회차 다음까지 — ${students.map((s) => s.name).join(' · ') || '학생 미정'} · ${text}`, NOTI_TITLE.consNextTask],
      );
    }
  }

  /* ══ 종료 — I-95 · N-18 채택 「필수 항목 + 약정 회차 후 명시 종료」 ═════════════════════════ */

  close(viewerId: number, canHide: boolean, consId: number, dto: ConsCloseDto, preview: boolean): Promise<ConsCloseResultDto> {
    return this.run(preview, async (q) => {
      const m = q.manager;
      const c = await this.consulting.lockFull(m, viewerId, canHide, consId);
      const today = todayKst();
      const [counts] = (await m.query(
        `SELECT (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND ${consSessDoneSql('x', '$2')}) AS done,
                (SELECT count(*)::int FROM cons_item i WHERE i.cons_id=$1 AND i.required AND NOT i.done) AS required_left`, [consId, today],
      )) as Array<{ done: number; required_left: number }>;
      const sessions = c.sessions == null ? null : Number(c.sessions);
      const sessionsDone = Number(counts?.done ?? 0);
      /* 앞으로 잡아 둔 회차 — 판정 안으로 옮겼다(S5). 전에는 여기서 따로 던져서 상세의 `canClose` 가
         그것을 모른 채 true 였고 단추가 헛섰다. 이제 화면과 쓰기가 **같은 함수**를 본다 (D-R39 · D-R22). */
      const [{ planned }] = (await m.query(
        `SELECT count(*)::int AS planned FROM cons_sess x WHERE x.cons_id = $1 AND x.on_date > $2::date`, [consId, today],
      )) as Array<{ planned: number }>;
      const issue = consultingCloseIssue({
        stage: String(c.stage), sessions, sessionsDone,
        requiredLeft: Number(counts?.required_left ?? 0), sessionsPlanned: Number(planned),
      });
      if (issue) throw new ConflictException(issue);
      const students = await this.students(m, consId);
      const studentNames = students.map((s) => s.name);
      const typeLabel = CONSULTING_TYPE_LABEL[String(c.cons_type) as ConsultingType] ?? String(c.cons_type);

      /* 안내문 — 문구 틀을 고르면 그 본문, 아니면 서버 기본 문장. 학생마다 PNOTI parent 한 줄 (발송처는 N-42) */
      let body: string;
      if (dto.templateId != null) {
        const [tpl] = (await m.query(`SELECT body FROM gtpl WHERE id = $1`, [dto.templateId])) as Array<{ body: string }>;
        if (!tpl) throw new NotFoundException({ code: 'GTPL_NOT_FOUND', message: '문구 틀을 찾을 수 없습니다' });
        body = tpl.body;
      } else {
        body = `컨설팅 종료 안내 — ${typeLabel} 컨설팅(${sessionsDone}회)이 마무리되었습니다. 그동안 함께해 주셔서 감사합니다.`;
      }
      if (dto.memo?.trim()) body += ` · ${dto.memo.trim()}`;
      const notices = (await m.query(
        `INSERT INTO pnoti (ser_id, on_date, audience, student_id, channel, body)
         SELECT NULL, $2::date, 'parent', unnest($1::bigint[]), 'app', $3 RETURNING id`,
        [students.map((s) => s.id), today, body],
      )) as Array<{ id: string }>;

      /* 단계 — 원본 §26 「종료 · 마무리하고 안내」. 종료일은 오늘 (예정일이 뒤면 당긴다 · 앞이면 그대로) */
      const [cons] = writtenRows<{ end_on: string | null }>(await m.query(
        `UPDATE cons SET stage = 'done',
                         end_on = CASE WHEN start_on IS NOT NULL AND start_on > $2::date THEN end_on
                                       WHEN end_on IS NULL OR end_on > $2::date THEN $2::date ELSE end_on END
          WHERE id = $1 AND stage = 'running' RETURNING to_char(end_on,'YYYY-MM-DD') AS end_on`, [consId, today],
      ));
      if (!cons) throw new ConflictException({ code: 'CONS_NOT_RUNNING', message: '진행 중인 컨설팅만 종료할 수 있습니다' });
      await m.query(`INSERT INTO cons_event (cons_id, event_type, by_id) VALUES ($1, 'closed', $2)`, [consId, viewerId]);
      let notified = false;
      if (c.owner_id != null && Number(c.owner_id) !== viewerId) {
        const rows = (await m.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) SELECT $1, $2, $3, '/consulting', 'etc', $4 FROM staff WHERE id = $1 AND active RETURNING id`,
          [Number(c.owner_id), viewerId, `컨설팅 종료 — ${studentNames.join(' · ')} · ${typeLabel} · ${sessionsDone}회`, NOTI_TITLE.consDone],
        )) as Array<{ id: string }>;
        notified = rows.length > 0;
      }
      return {
        preview, consId, stage: 'done', studentNames, noticeBody: body, parentNotices: notices.length,
        sessionsDone, sessions, sessionsPlanned: 0, endOn: cons.end_on ?? null, notified,
      };
    });
  }
}
