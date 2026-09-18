/** @file-guide
 * 목적: teacher-change.service.ts — TeacherChangeService (service)
 * 책임/재사용: 강사 교체를 한 트랜잭션으로 묶는다 — 시간표·안내·알림의 **기존 쓰기 함수**를 순서대로 부르고 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 교체 마법사 — 테스트 시나리오 J-97 · D-46 · N-132 · D-45 · F-62 (C93).
 *
 * 원본 v2 §2 데이터 흐름의 「강사를 바꾸면 EXC + GUIDE + PNOTI + ISSUE 동시 변경」이 이 서비스다. 여섯 단계를 **한 트랜잭션**에서 한다 —
 *   ① 스케줄 — 규칙마다 `ScheduleWriteService.patch(…, outer)` (day = 이번만 EXC · from = 그 날짜에서 규칙을 가른다 D-R16 · EXCLUDE 가 겹침을 막으면 전부 되돌아간다 · UNAV 는 응답)
 *   ② 안내 초안 — `GuidesService.draftsForTeacherChange` (§43 「한 번 보내는 것 — 강사 교체」 · F-62)
 *   ③ 학부모 안내 — PNOTI 행 (audience parent · 보낼 것으로 남는다 · 발송처는 N-42)
 *   ④ 교재 확인 — 이관 학생의 ISSUE 를 읽어 돌려준다 (우리 ISSUE 에는 강사 칸이 없어 바꿀 것이 없다 — 원문 `ISSUE.ins` 와 다른 자리)
 *   ⑤ 정산 시수 — 회차가 새 강사로 갔으니 `lib/payout-sheet` 가 저절로 따라온다 · 달마다 세어 주고 이미 확정된 달(N-51)은 그렇다고 말한다
 *   ⑥ 선생님 전달 — 새 강사 · 원래 강사(활성이면) · 관리자 NOTI
 * + 컴플레인이 있으면 `cpl.teacher_changed` 와 단계(접수 → 대응) · LOG. 미리보기는 같은 트랜잭션을 끝까지 돌리고 되돌린다(D-R37).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { ruleLabel } from '../../lib/recurrence';
import { kstDateOf, serStuOn, writtenRows } from '../../lib/sql';
import { GuidesService } from '../guides/guides.service';
import type { UnavWarnDto } from '../schedule/schedule.dto';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import type { TcBookDto, TcPayoutMonthDto, TcSeriesDto, TcStaffDto, TcStepDto, TeacherChangeDto, TeacherChangeResultDto } from './teacher-change.dto';

class PreviewRollback extends Error {
  constructor(public readonly result: TeacherChangeResultDto) { super('preview'); }
}

const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const TEACHER_OF = 'COALESCE(o.teacher_id, s.teacher_id)';

interface Target { serId: number; onDate: string; calDate: string; title: string; kindName: string; subName: string | null; rrule: string; startMin: number; endMin: number }

@Injectable()
export class TeacherChangeService {
  constructor(
    private readonly ds: DataSource,
    private readonly schedule: ScheduleWriteService,
    private readonly guides: GuidesService,
  ) {}

  preview(userId: number, dto: TeacherChangeDto): Promise<TeacherChangeResultDto> { return this.run(userId, dto, true); }
  apply(userId: number, dto: TeacherChangeDto): Promise<TeacherChangeResultDto> { return this.run(userId, dto, false); }

  private async run(userId: number, dto: TeacherChangeDto, preview: boolean): Promise<TeacherChangeResultDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const result = await this.body(q, userId, dto, preview);
      if (preview) throw new PreviewRollback(result);
      await q.commitTransaction();
      return result;
    } catch (e) {
      await q.rollbackTransaction();
      if (e instanceof PreviewRollback) return e.result;
      throw e;
    } finally {
      await q.release();
    }
  }

  private async body(q: QueryRunner, userId: number, dto: TeacherChangeDto, preview: boolean): Promise<TeacherChangeResultDto> {
    const m: EntityManager = q.manager;
    if (dto.fromTeacherId === dto.toTeacherId) throw new BadRequestException({ code: 'SAME_TEACHER', message: '원래 강사와 새 강사가 같습니다' });
    const from = await this.staff(m, dto.fromTeacherId);
    const to = await this.staff(m, dto.toTeacherId);
    if (!to.active) throw new BadRequestException({ code: 'STAFF_INACTIVE', message: `${to.name} 은(는) 활동 중이 아닙니다 — 그만둔 사람에게 수업을 줄 수 없습니다` });

    /* ── 컴플레인 — 있으면 잠그고, 학생이 있으면 그 학생의 수업으로 좁힌다 (J-97) ── */
    let cplRow: { id: number; stage: string; studentId: number | null } | null = null;
    if (dto.cplId) {
      const [c] = (await m.query(`SELECT id, stage, student_id FROM cpl WHERE id = $1 FOR UPDATE`, [dto.cplId])) as Array<{ id: string; stage: string; student_id: string | null }>;
      if (!c) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      cplRow = { id: Number(c.id), stage: c.stage, studentId: c.student_id == null ? null : Number(c.student_id) };
    }
    const studentId = dto.studentId ?? cplRow?.studentId ?? null;

    /* ── ① 대상 — 그날(day) 또는 그 날부터(from)의 원래 강사 회차 ── */
    const targets = await this.targets(m, dto, from.id, studentId);
    if (!targets.length) {
      throw new BadRequestException({
        code: 'NOTHING_TO_CHANGE',
        message: dto.mode === 'day' ? `${md(dto.date)} 에 ${from.name} 의 수업이 없습니다` : `${md(dto.date)} 부터 ${from.name} 이(가) 맡은 수업이 없습니다`,
      });
    }
    const unavailable: UnavWarnDto[] = [];
    const series: TcSeriesDto[] = [];
    const touchedAll: number[] = [];
    for (const t of targets) {
      let written;
      try {
        written = await this.schedule.patch(
          t.serId, { scope: dto.mode === 'day' ? 'this' : 'future', onDate: t.onDate, teacherId: to.id },
          undefined, userId, q,
        );
      } catch (e) {
        // 겹침은 시간표(EXCLUDE · pg 23P01)가 막고 보통은 ApiErrorFilter 가 사람 말로 옮긴다 — 여기서는 **어느 수업에서** 막혔는지만 문장에 보탠다
        // (코드는 필터와 같은 RESOURCE_CONFLICT · 화면이 「누구와」를 묻는 열쇠다). 다른 오류는 그대로 던진다.
        const pg = (e as { driverError?: { code?: string; constraint?: string }; code?: string }) ?? {};
        const pgCode = pg.driverError?.code ?? pg.code;
        const constraint = pg.driverError?.constraint ?? '';
        if (pgCode === '23P01' && constraint !== 'stu_pause_no_overlap') {
          throw new ConflictException({
            code: 'RESOURCE_CONFLICT',
            message: `같은 시간에 강사·강의실·줌이 이미 잡혀 있습니다 — ${t.subName ?? (t.title || t.kindName)} · ${md(t.calDate)} ${hhmm(t.startMin)}–${hhmm(t.endMin)} · ${to.name}`,
          });
        }
        throw e;
      }
      unavailable.push(...written.unavailable);
      const newSerId = written.serIds.find((id) => id !== t.serId) ?? null;
      const liveId = newSerId ?? t.serId;
      touchedAll.push(...written.serIds);
      const students = (await m.query(
        `SELECT st.name FROM ser_stu ss JOIN stu st ON st.id = ss.student_id WHERE ss.ser_id = $1 AND ${serStuOn('ss', '$2::date')} ORDER BY st.name`,
        [liveId, t.onDate],
      )) as Array<{ name: string }>;
      const [cnt] = (await m.query(
        `SELECT count(*)::int AS n FROM ser_occ o JOIN ser s ON s.id = o.ser_id
          WHERE o.ser_id = $1 AND NOT o.canceled AND ${TEACHER_OF} = $2
            AND ($3::boolean OR ${kstDateOf('lower(o.span)')} = $4::date)`,
        [liveId, to.id, dto.mode === 'from', dto.date],
      )) as Array<{ n: number }>;
      series.push({
        serId: t.serId, newSerId, title: t.title, kindName: t.kindName, subName: t.subName, ruleLabel: ruleLabel({ rrule: t.rrule }),
        startMin: t.startMin, endMin: t.endMin, students: students.map((r) => r.name), occurrences: Number(cnt.n), firstOn: t.calDate,
      });
    }
    const liveIds = series.map((s) => s.newSerId ?? s.serId);
    const occurrences = series.reduce((a, s) => a + s.occurrences, 0);
    const dayTo = dto.mode === 'day' ? dto.date : null;

    /* ── ② 안내 초안 (GUIDE · F-62) ── */
    const guideIds = await this.guides.draftsForTeacherChange(m, userId, liveIds, dto.date, dayTo);

    /* ── ③ 학부모 안내 (PNOTI parent) — 첫 바뀐 회차에 학생마다 한 줄 · 발송처는 아직 없다 (N-42) ── */
    let parentNotices = 0;
    for (const s of series) {
      const liveId = s.newSerId ?? s.serId;
      const label = s.subName ?? (s.title || s.kindName);
      const body = dto.mode === 'day'
        ? `강사 대강 안내 — ${md(s.firstOn)} ${label} 수업은 ${to.name} 선생님이 대신 진행합니다${dto.memo ? ` · ${dto.memo.trim()}` : ''}`
        : `강사 교체 안내 — ${md(s.firstOn)}부터 ${label} 수업은 ${to.name} 선생님이 맡습니다${dto.memo ? ` · ${dto.memo.trim()}` : ''}`;
      const rows = (await m.query(
        `INSERT INTO pnoti (ser_id, on_date, audience, student_id, channel, body)
         SELECT $1, $2::date, 'parent', ss.student_id, 'app', $3
           FROM ser_stu ss WHERE ss.ser_id = $1 AND ${serStuOn('ss', '$2::date')}
            AND NOT EXISTS (SELECT 1 FROM pnoti p WHERE p.ser_id = $1 AND p.on_date = $2::date AND p.student_id = ss.student_id AND p.audience = 'parent' AND p.body = $3)
         RETURNING id`,
        [liveId, await this.ruleDate(m, liveId, s.firstOn), body],
      )) as Array<{ id: string }>;
      parentNotices += rows.length;
    }

    /* ── ④ 교재 확인 — 이관 학생의 배부 교재 (읽기) ── */
    const books = (await m.query(
      `SELECT DISTINCT st.name AS student_name, l.title, i.state
         FROM issue i JOIN lib l ON l.id = i.lib_id JOIN stu st ON st.id = i.student_id
        WHERE i.state IN ('wait','ok') AND i.returned_on IS NULL
          AND i.student_id IN (SELECT ss.student_id FROM ser_stu ss WHERE ss.ser_id = ANY($1))
        ORDER BY st.name, l.title`,
      [liveIds],
    )) as Array<{ student_name: string; title: string; state: string }>;
    const bookRows: TcBookDto[] = books.map((b) => ({ studentName: b.student_name, title: b.title, state: b.state }));

    /* ── ⑤ 정산 시수 — 달마다 옮겨 간 회차 · 확정된 달은 되돌리지 않는다 (N-51) ── */
    const months = (await m.query(
      `SELECT to_char(o.on_date,'YYYY-MM') AS month, count(*)::int AS n FROM ser_occ o JOIN ser s ON s.id = o.ser_id
        WHERE o.ser_id = ANY($1) AND NOT o.canceled AND ${TEACHER_OF} = $2
          AND ($3::boolean OR ${kstDateOf('lower(o.span)')} = $4::date)
        GROUP BY 1 ORDER BY 1`,
      [liveIds, to.id, dto.mode === 'from', dto.date],
    )) as Array<{ month: string; n: number }>;
    const confirmed = (await m.query(
      `SELECT year_month, staff_id FROM payout WHERE staff_id = ANY($1) AND year_month = ANY($2) AND confirmed_by IS NOT NULL`,
      [[from.id, to.id], months.map((r) => r.month)],
    )) as Array<{ year_month: string; staff_id: string }>;
    const payout: TcPayoutMonthDto[] = months.map((r) => ({
      month: r.month, occurrences: Number(r.n),
      fromConfirmed: confirmed.some((c) => c.year_month === r.month && Number(c.staff_id) === from.id),
      toConfirmed: confirmed.some((c) => c.year_month === r.month && Number(c.staff_id) === to.id),
    }));

    /* ── ⑥ 선생님 전달 — 새 강사 · 원래 강사(활성 · 본인 제외) · 관리자 ── */
    const studentNames = [...new Set(series.flatMap((s) => s.students))];
    const what = `${series.map((s) => s.subName ?? (s.title || s.kindName)).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}${studentNames.length ? ` (${studentNames.slice(0, 3).join(' · ')}${studentNames.length > 3 ? ` 외 ${studentNames.length - 3}명` : ''})` : ''}`;
    const when = dto.mode === 'day' ? `${md(dto.date)} 하루 대강` : `${md(dto.date)}부터`;
    let notifiedTeachers = 0;
    const link = `/schedule?date=${dto.date}`;
    for (const [who, text] of [
      [to.id, `강사 교체 — ${what} · ${when} · 회차 ${occurrences}회를 맡습니다${dto.memo ? ` · ${dto.memo.trim()}` : ''}`],
      [from.id, `담당 이관 — ${what} · ${when} → ${to.name}`],
    ] as Array<[number, string]>) {
      if (who === userId) continue;
      const rows = (await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category) SELECT $1, $2, $3, $4, 'schedule' FROM staff WHERE id = $1 AND active RETURNING id`,
        [who, userId, text, link],
      )) as Array<{ id: string }>;
      notifiedTeachers += rows.length;
    }
    const staffRows = (await m.query(
      `INSERT INTO noti (to_id, from_id, body, link, category)
       SELECT id, $1, $2, $3, 'etc' FROM staff WHERE active AND role <> 'teacher' AND id <> $1 AND id <> $4 AND id <> $5 RETURNING id`,
      [userId, `강사 교체 — ${from.name} → ${to.name} · ${what} · ${when}${cplRow ? ` · 컴플레인 #${cplRow.id}` : ''}`,
        cplRow ? '/ops?tab=complaint' : link, from.id, to.id],
    )) as Array<{ id: string }>;
    const notifiedStaff = staffRows.length;

    /* ── 컴플레인 도장 · LOG ── */
    let cpl: TeacherChangeResultDto['cpl'] = null;
    if (cplRow) {
      // UPDATE … RETURNING 은 [rows, affected] 로 온다 (C85-a 의 그 함정) — writtenRows 로 편다
      const [row] = writtenRows<{ stage: string }>(await m.query(
        // 접수 건은 대응으로 — 「담당을 정해야 합니다」(§67) 는 마법사를 돌린 사람이 채운다
        `UPDATE cpl SET teacher_changed = true, stage = CASE WHEN stage = 'received' THEN 'acting' ELSE stage END,
                        owner_id = COALESCE(owner_id, $3), action = COALESCE(action, $2)
          WHERE id = $1 RETURNING stage`,
        [cplRow.id, `강사 교체 — ${from.name} → ${to.name} · ${when}`, userId],
      ));
      if (!row) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      cpl = { id: cplRow.id, stage: row.stage, teacherChanged: true };
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'CPL',$2,'teacher-change',$3::jsonb,$4::jsonb)`,
        [userId, cplRow.id, JSON.stringify({ stage: cplRow.stage, teacherChanged: false }), JSON.stringify({ stage: row.stage, teacherChanged: true, from: from.id, to: to.id, date: dto.date, mode: dto.mode, preview })],
      );
    }
    await m.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'teacher-change',$3::jsonb,$4::jsonb)`,
      [userId, from.id, JSON.stringify({ teacherId: from.id }), JSON.stringify({
        teacherId: to.id, mode: dto.mode, date: dto.date, serIds: series.map((s) => s.serId), newSerIds: series.map((s) => s.newSerId).filter((x) => x != null),
        occurrences, guideIds, parentNotices, cplId: cplRow?.id ?? null, preview,
      })],
    );

    const steps: TcStepDto[] = [
      { key: 'schedule', label: '스케줄', count: occurrences, note: `규칙 ${series.length}개 · 회차 ${occurrences}회 — ${dto.mode === 'day' ? '이날만 대강(회차 예외)' : `${md(dto.date)}부터 계속(규칙을 가른다)`}` },
      { key: 'guide', label: '안내 초안', count: guideIds.length, note: guideIds.length ? '학생마다 강사 교체 안내 초안 — 수업 안내 §43 에서 다듬어 보냅니다' : '새로 만들 초안이 없습니다(이미 있음)' },
      { key: 'parent', label: '학부모 안내', count: parentNotices, note: '보낼 안내로 남겼습니다 — 학부모 수신처는 아직 없습니다 (N-42)' },
      { key: 'book', label: '교재 확인', count: bookRows.length, note: bookRows.length ? '이관 학생의 배부 교재 — 새 강사가 이어받습니다(바꿀 것 없음)' : '배부된 교재가 없습니다' },
      { key: 'payout', label: '정산 시수', count: occurrences, note: payout.length ? payout.map((p) => `${+p.month.slice(5)}월 ${p.occurrences}회 → ${to.name}${p.fromConfirmed || p.toConfirmed ? ' (확정된 달 — 되돌리지 않습니다 N-51)' : ''}`).join(' · ') : '옮겨 간 회차가 없습니다' },
      { key: 'notify', label: '선생님 전달', count: notifiedTeachers, note: `새 강사 ${to.name}${from.active && from.id !== userId ? ` · 원래 강사 ${from.name}` : ''} · 관리자 ${notifiedStaff}명` },
    ];
    return { preview, mode: dto.mode, date: dto.date, fromTeacher: from, toTeacher: to, series, occurrences, guideDrafts: guideIds.length, parentNotices, books: bookRows, payout, notifiedTeachers, notifiedStaff, unavailable, cpl, steps };
  }

  private async staff(m: EntityManager, id: number): Promise<TcStaffDto> {
    const [st] = (await m.query(`SELECT id, name, active FROM staff WHERE id = $1`, [id])) as Array<{ id: string; name: string; active: boolean }>;
    if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: `구성원 ${id} 을(를) 찾을 수 없습니다` });
    return { id: Number(st.id), name: st.name, active: Boolean(st.active) };
  }

  /** 규칙 날짜(EXC 키) — 달력 날짜로 첫 바뀐 회차를 찾았으니 그 회차의 on_date 를 되짚는다 */
  private async ruleDate(m: EntityManager, serId: number, calDate: string): Promise<string> {
    const [r] = (await m.query(
      `SELECT to_char(o.on_date,'YYYY-MM-DD') AS on_date FROM ser_occ o WHERE o.ser_id = $1 AND ${kstDateOf('lower(o.span)')} = $2::date ORDER BY o.id LIMIT 1`,
      [serId, calDate],
    )) as Array<{ on_date: string }>;
    return r?.on_date ?? calDate;
  }

  /** 대상 회차 — day: 그날의 회차 하나씩 · from: 규칙마다 그 날 이후 첫 회차 (patch 의 onDate = 규칙 날짜) */
  private async targets(m: EntityManager, dto: TeacherChangeDto, fromId: number, studentId: number | null): Promise<Target[]> {
    const rows = (await m.query(
      `SELECT DISTINCT ON (o.ser_id) o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS cal_date,
              s.title, k.name AS kind_name, sb.name AS sub_name, s.rrule, s.start_min, s.end_min
         FROM ser_occ o JOIN ser s ON s.id = o.ser_id JOIN kind k ON k.key = s.kind_key LEFT JOIN sub sb ON sb.key = s.sub_key
        WHERE NOT o.canceled
          /* day 는 그날 실제로 맡는 사람(대강 예외 포함) · from 은 규칙의 강사 — 남의 규칙에 잠깐 대강으로 든 회차 때문에 그 규칙을 통째로 가르지 않는다 */
          AND (($2::boolean AND ${kstDateOf('lower(o.span)')} = $3::date AND ${TEACHER_OF} = $1)
            OR (NOT $2::boolean AND o.on_date >= $3::date AND s.teacher_id = $1))
          AND ($4::bigint[] IS NULL OR o.ser_id = ANY($4))
          AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ss.student_id = $5 AND ${serStuOn('ss', 'o.on_date')}))
        ORDER BY o.ser_id, o.on_date, o.id`,
      [fromId, dto.mode === 'day', dto.date, dto.serIds?.length ? dto.serIds : null, studentId],
    )) as Array<{ ser_id: string; on_date: string; cal_date: string; title: string; kind_name: string; sub_name: string | null; rrule: string; start_min: number; end_min: number }>;
    return rows.map((r) => ({
      serId: Number(r.ser_id), onDate: r.on_date, calDate: r.cal_date, title: String(r.title ?? ''), kindName: r.kind_name, subName: r.sub_name ?? null,
      rrule: r.rrule, startMin: Number(r.start_min), endMin: Number(r.end_min),
    }));
  }
}
