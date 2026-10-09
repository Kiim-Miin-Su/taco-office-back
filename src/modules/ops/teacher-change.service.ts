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
 *   ④ 교재 이관 — from은 이전 강사 소유 ISSUE를 새 강사로 옮기고, day는 하루 대강이라 소유자를 유지한다(관리자 수정사항 122~124장)
 *   ⑤ 정산 시수 — 회차가 새 강사로 갔으니 `lib/payout-sheet` 가 저절로 따라온다 · 달마다 세어 주고 이미 확정된 달(N-51)은 그렇다고 말한다
 *   ⑥ 선생님 전달 — 새 강사 · 원래 강사(활성이면) · 관리자 NOTI
 * + 컴플레인이 있으면 `cpl.teacher_changed` 와 단계(접수 → 대응) · LOG. 미리보기는 같은 트랜잭션을 끝까지 돌리고 되돌린다(D-R37).
 *
 * **코드 리뷰 2026-09-28 (TBO-54)** —
 *   CR-BE-01 · 학생 명단은 규칙 날짜(`on_date`)로, 교재 대상은 옮긴 달력 날짜(`lower(o.span)`)로 세고 있었다. 명단 경계일을 넘어 옮긴
 *     EXC 회차에서 화면의 학생과 교재의 학생이 갈렸다. 이제 명단·학부모 안내·교재가 **같은 실효 명단 기준일 하나**(`rosterDate` — 규칙 날짜)를 쓴다.
 *     기준을 규칙 날짜로 둔 근거: 투영(schedule.project)·수업 상세·청구(invoice-lines)·정산(payout-sheet)·안내 초안이 전부 `serStuOn(ss, o.on_date)` 다.
 *   CR-BE-02 · 학생 A 의 `cplId` 와 학생 B 의 `studentId` 를 함께 보내면 B 의 수업을 바꾸면서 A 의 컴플레인을 완료 처리할 수 있었다.
 *     컴플레인에 학생이 있으면 대상은 **그 학생으로 고정**하고, 다른 학생을 함께 보낸 요청은 어느 쓰기도 하기 전에 400 `CPL_STUDENT_MISMATCH` 로 거절한다.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { ruleLabel } from '../../lib/recurrence';
import { NOTI_TITLE } from '../../lib/noti';
import { issueActiveSql } from '../../lib/book';
import { kstDateOf, serStuOn, writtenRows } from '../../lib/sql';
import { GuidesService } from '../guides/guides.service';
import type { UnavWarnDto } from '../schedule/schedule.dto';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import { lockKinderRosterPolicyWrite } from '../../lib/kinder-roster.db';
import { histSql } from '../../lib/history';
import { todayKst } from '../../lib/kst';
import type {
  TcBookDto, TcPayoutMonthDto, TcSeriesDto, TcStaffDto, TcStepDto, TeacherChangeDto, TeacherChangeResultDto,
  TeacherChangeUndoResultDto,
} from './teacher-change.dto';

class PreviewRollback extends Error {
  constructor(public readonly result: TeacherChangeResultDto) { super('preview'); }
}

const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const TEACHER_OF = 'COALESCE(o.teacher_id, s.teacher_id)';

interface Target { serId: number; onDate: string; calDate: string; title: string; kindName: string; subKey: string | null; subName: string | null; rrule: string; startMin: number; endMin: number }
interface LiveTarget { liveId: number; rosterDate: string; subKey: string | null }
interface BookAssignmentRow {
  teacher_id: string;
  teacher_name: string;
  student_id: string;
  student_name: string;
  issue_id: string;
  lib_id: string;
  title: string;
  state: string;
  sub_key: string;
  row_version: number;
}

interface TeacherChangeUndoPayload {
  scheduleTokens: string[];
  guideIds: number[];
  parentNoticeIds: number[];
  notificationIds: number[];
  books: Array<{ issueId: number; fromTeacherId: number; toTeacherId: number; appliedVersion: number }>;
  complaint: null | {
    id: number;
    before: { stage: string; teacherChanged: boolean; ownerId: number | null; action: string | null };
    after: { stage: string; teacherChanged: boolean; ownerId: number | null; action: string | null };
  };
}

interface TeacherChangeWork { result: TeacherChangeResultDto; undo: TeacherChangeUndoPayload }

const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class TeacherChangeService {
  constructor(
    private readonly ds: DataSource,
    private readonly schedule: ScheduleWriteService,
    private readonly guides: GuidesService,
  ) {}

  preview(userId: number, dto: TeacherChangeDto): Promise<TeacherChangeResultDto> { return this.run(userId, dto, true); }
  apply(userId: number, dto: TeacherChangeDto): Promise<TeacherChangeResultDto> { return this.run(userId, dto, false); }

  async undo(userId: number, requestKey: string, expectedVersion: number): Promise<TeacherChangeUndoResultDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await lockKinderRosterPolicyWrite(q);
      const [operation] = (await q.manager.query(
        `SELECT actor_id,state,row_version,undo_payload FROM teacher_change_operation WHERE request_key=$1 FOR UPDATE`,
        [requestKey],
      )) as Array<{ actor_id: string; state: string; row_version: number; undo_payload: TeacherChangeUndoPayload }>;
      if (!operation) throw new NotFoundException({ code: 'TEACHER_CHANGE_NOT_FOUND', message: '강사 교체 작업을 찾을 수 없습니다' });
      if (Number(operation.actor_id) !== userId) {
        throw new ForbiddenException({ code: 'TEACHER_CHANGE_UNDO_ACTOR', message: '강사 교체를 실행한 관리자만 실행 취소할 수 있습니다' });
      }
      if (Number(operation.row_version) !== expectedVersion) {
        throw new ConflictException({
          code: 'TEACHER_CHANGE_UNDO_VERSION_CONFLICT', message: '강사 교체 작업 상태가 바뀌었습니다. 다시 읽어 주세요',
          expectedVersion, actualVersion: Number(operation.row_version),
        });
      }
      if (operation.state === 'undone') {
        throw new ConflictException({ code: 'TEACHER_CHANGE_ALREADY_UNDONE', message: '이미 실행 취소한 강사 교체입니다' });
      }
      const payload = operation.undo_payload;
      if (payload.parentNoticeIds.length) {
        const [sent] = (await q.manager.query(
          `SELECT id FROM pnoti WHERE id=ANY($1) AND sent_at IS NOT NULL LIMIT 1`, [payload.parentNoticeIds],
        )) as Array<{ id: string }>;
        if (sent) throw new ConflictException({ code: 'TEACHER_CHANGE_UNDO_DELIVERED', message: '학부모 안내가 이미 발송되어 교체를 실행 취소할 수 없습니다' });
      }
      if (payload.guideIds.length) {
        const [changed] = (await q.manager.query(
          `SELECT id FROM guide WHERE id=ANY($1) AND state<>'draft'::guide_state_t LIMIT 1`, [payload.guideIds],
        )) as Array<{ id: string }>;
        if (changed) throw new ConflictException({ code: 'TEACHER_CHANGE_UNDO_GUIDE_CHANGED', message: '교체 안내 초안이 이미 수정되거나 발송되어 실행 취소할 수 없습니다' });
      }
      for (const book of payload.books) {
        const [current] = (await q.manager.query(
          `SELECT teacher_id,row_version FROM issue WHERE id=$1 FOR UPDATE`, [book.issueId],
        )) as Array<{ teacher_id: string | null; row_version: number }>;
        if (!current || Number(current.teacher_id) !== book.toTeacherId || Number(current.row_version) !== book.appliedVersion) {
          throw new ConflictException({ code: 'TEACHER_CHANGE_UNDO_BOOK_CHANGED', message: '교체 뒤 교재 담당이 다시 바뀌어 실행 취소할 수 없습니다', issueId: book.issueId });
        }
      }
      if (payload.complaint) {
        const [current] = (await q.manager.query(
          `SELECT stage,teacher_changed,owner_id,action FROM cpl WHERE id=$1 FOR UPDATE`, [payload.complaint.id],
        )) as Array<{ stage: string; teacher_changed: boolean; owner_id: string | null; action: string | null }>;
        const normalized = current ? {
          stage: current.stage, teacherChanged: Boolean(current.teacher_changed),
          ownerId: current.owner_id == null ? null : Number(current.owner_id), action: current.action,
        } : null;
        // JSONB는 객체 키 순서를 보존하지 않는다. 직렬화 문자열 비교를 쓰면 내용이 같아도
        // key order만 달라 실제 브라우저 undo가 409가 된다. BO-12C 권고안의 의미 필드를 직접 비교한다.
        const expected = payload.complaint.after;
        if (!normalized || normalized.stage !== expected.stage || normalized.teacherChanged !== expected.teacherChanged
          || normalized.ownerId !== expected.ownerId || normalized.action !== expected.action) {
          throw new ConflictException({ code: 'TEACHER_CHANGE_UNDO_COMPLAINT_CHANGED', message: '교체 뒤 컴플레인이 다시 바뀌어 실행 취소할 수 없습니다' });
        }
      }

      if (payload.parentNoticeIds.length) await q.manager.query(`DELETE FROM pnoti WHERE id=ANY($1)`, [payload.parentNoticeIds]);
      if (payload.guideIds.length) await q.manager.query(`DELETE FROM guide WHERE id=ANY($1)`, [payload.guideIds]);
      for (const book of payload.books) {
        await q.manager.query(`UPDATE issue SET teacher_id=$2,row_version=row_version+1 WHERE id=$1`, [book.issueId, book.fromTeacherId]);
        await q.manager.query(histSql(), ['issue', book.issueId, 'teacher_swap_undo', userId]);
        await q.manager.query(
          `INSERT INTO log(actor_id,entity,entity_id,action,before,after) VALUES($1,'ISSUE',$2,'teacher-change-undo',$3::jsonb,$4::jsonb)`,
          [userId, book.issueId, JSON.stringify({ teacherId: book.toTeacherId, rowVersion: book.appliedVersion }),
            JSON.stringify({ teacherId: book.fromTeacherId, rowVersion: book.appliedVersion + 1, requestKey })],
        );
      }
      if (payload.complaint) {
        const before = payload.complaint.before;
        await q.manager.query(
          `UPDATE cpl SET stage=$2,teacher_changed=$3,owner_id=$4,action=$5 WHERE id=$1`,
          [payload.complaint.id, before.stage, before.teacherChanged, before.ownerId, before.action],
        );
      }
      for (const token of [...payload.scheduleTokens].reverse()) await this.schedule.undo(userId, token, undefined, q);

      if (payload.notificationIds.length) {
        await q.manager.query(
          `INSERT INTO noti(to_id,from_id,body,link,category,title)
           SELECT DISTINCT n.to_id,$2::bigint,'강사 교체가 실행 취소되었습니다',n.link,'schedule','강사 교체 실행 취소'
             FROM noti n WHERE n.id=ANY($1)`,
          [payload.notificationIds, userId],
        );
      }
      await q.manager.query(
        `INSERT INTO log(actor_id,entity,entity_id,action,before,after)
          VALUES($1,'TEACHER_CHANGE',$1,'teacher-change-undo',$2::jsonb,$3::jsonb)`,
        [userId, JSON.stringify({ requestKey, state: 'applied', rowVersion: 1 }), JSON.stringify({ requestKey, state: 'undone', rowVersion: 2 })],
      );
      const [changed] = writtenRows<{ row_version: number; undone_at: string }>(await q.manager.query(
        `UPDATE teacher_change_operation SET state='undone',row_version=2,undone_by=$2,undone_at=now()
          WHERE request_key=$1 RETURNING row_version,undone_at`,
        [requestKey, userId],
      ));
      const actor = await this.staff(q.manager, userId);
      await q.commitTransaction();
      return { requestKey, rowVersion: Number(changed.row_version), state: 'undone', actor: { id: actor.id, name: actor.name }, undoneAt: changed.undone_at };
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }

  private async run(userId: number, dto: TeacherChangeDto, preview: boolean): Promise<TeacherChangeResultDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await lockKinderRosterPolicyWrite(q);
      const commandFingerprint = sha256({
        fromTeacherId: dto.fromTeacherId, toTeacherId: dto.toTeacherId, mode: dto.mode, date: dto.date,
        serIds: dto.serIds ? [...dto.serIds].sort((a, b) => a - b) : null,
        studentId: dto.studentId ?? null, cplId: dto.cplId ?? null, memo: dto.memo?.trim() ?? null,
        scope: dto.scope ?? 'student_classes', expectedVersion: dto.expectedVersion ?? null,
      });
      if (!preview && dto.requestKey) {
        await q.manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`teacher-change:${dto.requestKey}`]);
        const [prior] = (await q.manager.query(
          `SELECT command_fingerprint,state,result FROM teacher_change_operation WHERE request_key=$1 FOR UPDATE`,
          [dto.requestKey],
        )) as Array<{ command_fingerprint: string; state: string; result: TeacherChangeResultDto }>;
        if (prior) {
          if (prior.command_fingerprint !== commandFingerprint) {
            throw new ConflictException({ code: 'TEACHER_CHANGE_REQUEST_REUSED', message: '같은 requestKey를 다른 강사 교체에 다시 사용할 수 없습니다' });
          }
          if (prior.state === 'undone') {
            throw new ConflictException({ code: 'TEACHER_CHANGE_ALREADY_UNDONE', message: '이미 실행 취소한 강사 교체입니다' });
          }
          await q.commitTransaction();
          return prior.result;
        }
      }
      const work = await this.body(q, userId, dto, preview);
      if (preview) throw new PreviewRollback(work.result);
      await q.manager.query(
        `INSERT INTO teacher_change_operation(request_key,actor_id,command_fingerprint,expected_version,result,undo_payload)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [dto.requestKey, userId, commandFingerprint, dto.expectedVersion, JSON.stringify(work.result), JSON.stringify(work.undo)],
      );
      await q.commitTransaction();
      return work.result;
    } catch (e) {
      await q.rollbackTransaction();
      if (e instanceof PreviewRollback) return e.result;
      throw e;
    } finally {
      await q.release();
    }
  }

  private async body(q: QueryRunner, userId: number, dto: TeacherChangeDto, preview: boolean): Promise<TeacherChangeWork> {
    const m: EntityManager = q.manager;
    if (dto.mode === 'day' && dto.date < todayKst()) {
      throw new BadRequestException({ code: 'TEACHER_CHANGE_PAST_DAY', message: '지난 날짜에는 하루 대강을 만들 수 없습니다' });
    }
    if (dto.fromTeacherId === dto.toTeacherId) throw new BadRequestException({ code: 'SAME_TEACHER', message: '원래 강사와 새 강사가 같습니다' });
    const from = await this.staff(m, dto.fromTeacherId);
    const to = await this.staff(m, dto.toTeacherId);
    const actor = await this.staff(m, userId);
    if (!to.active) throw new BadRequestException({ code: 'STAFF_INACTIVE', message: `${to.name} 은(는) 활동 중이 아닙니다 — 그만둔 사람에게 수업을 줄 수 없습니다` });

    /* ── 컴플레인 — 있으면 잠그고, 학생이 있으면 그 학생의 수업으로 **고정**한다 (J-97 · CR-BE-02) ── */
    let cplRow: { id: number; stage: string; studentId: number | null; teacherChanged: boolean; ownerId: number | null; action: string | null } | null = null;
    if (dto.cplId) {
      const [c] = (await m.query(`SELECT id,stage,student_id,teacher_changed,owner_id,action FROM cpl WHERE id = $1 FOR UPDATE`, [dto.cplId])) as Array<{
        id: string; stage: string; student_id: string | null; teacher_changed: boolean; owner_id: string | null; action: string | null;
      }>;
      if (!c) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      cplRow = {
        id: Number(c.id), stage: c.stage, studentId: c.student_id == null ? null : Number(c.student_id),
        teacherChanged: Boolean(c.teacher_changed), ownerId: c.owner_id == null ? null : Number(c.owner_id), action: c.action,
      };
      // 학생 A 의 컴플레인에 학생 B 를 실어 보내면 B 의 수업을 바꾸며 A 의 컴플레인이 완료된다 — 어느 쓰기도 하기 전에 거절한다 (CR-BE-02)
      if (cplRow.studentId != null && dto.studentId != null && dto.studentId !== cplRow.studentId) {
        throw new BadRequestException({
          code: 'CPL_STUDENT_MISMATCH',
          message: `컴플레인 #${cplRow.id} 의 학생과 요청의 학생이 다릅니다 — 컴플레인에서 온 교체는 그 컴플레인의 학생 수업만 바꿉니다`,
        });
      }
    }
    // 컴플레인의 학생이 있으면 그 학생이 대상이다(요청의 studentId 는 같은 값일 때만 통과했다) · 없으면 요청이 좁힌 학생 · 둘 다 없으면 전부
    const studentId = cplRow?.studentId ?? dto.studentId ?? null;

    /* ── ① 대상 — 그날(day) 또는 그 날부터(from)의 원래 강사 회차 ── */
    const targets = await this.targets(m, dto, from.id, studentId);
    if (!targets.length) {
      if (!preview && dto.expectedVersion) {
        throw new ConflictException({ code: 'TEACHER_CHANGE_VERSION_CONFLICT', message: '미리보기 뒤 대상 수업이 바뀌었습니다. 다시 미리 봐 주세요' });
      }
      throw new BadRequestException({
        code: 'NOTHING_TO_CHANGE',
        message: dto.mode === 'day' ? `${md(dto.date)} 에 ${from.name} 의 수업이 없습니다` : `${md(dto.date)} 부터 ${from.name} 이(가) 맡은 수업이 없습니다`,
      });
    }
    const inspection = await this.inspectTargets(m, targets, dto, from.id, to.id, cplRow);
    if (!preview && (!dto.requestKey || !dto.expectedVersion)) {
      throw new BadRequestException({ code: 'TEACHER_CHANGE_RECEIPT_REQUIRED', message: '미리보기의 version과 새 requestKey로 교체를 확정해 주세요' });
    }
    const scope = dto.scope ?? 'student_classes';
    const requiresWholeClass = studentId !== null && inspection.rosters.some((roster) => roster.studentIds.length > 1);
    if (!preview && requiresWholeClass && scope !== 'whole_class') {
      throw new ConflictException({
        code: 'TEACHER_CHANGE_WHOLE_CLASS_REQUIRED',
        message: '그룹 수업은 학생 한 명만 떼어 교체할 수 없습니다. 미리 본 동일 명단의 반 전체 교체를 확인해 주세요',
        series: inspection.rosters.filter((roster) => roster.studentIds.length > 1),
      });
    }
    if (!preview && dto.expectedVersion !== inspection.version) {
      throw new ConflictException({
        code: 'TEACHER_CHANGE_VERSION_CONFLICT',
        message: '미리보기 뒤 대상 수업·명단·교재가 바뀌었습니다. 다시 미리 봐 주세요',
        expectedVersion: dto.expectedVersion,
        actualVersion: inspection.version,
      });
    }
    const unavailable: UnavWarnDto[] = [];
    const series: TcSeriesDto[] = [];
    /** 규칙마다 실제로 살아 있는 규칙(from 이면 갈라진 새 규칙)과 **명단 기준일 하나** — 명단·학부모 안내·교재가 전부 이것을 본다 (CR-BE-01) */
    const live: LiveTarget[] = [];
    const touchedAll: number[] = [];
    const scheduleTokens: string[] = [];
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
      if (written.undoToken) scheduleTokens.push(written.undoToken);
      const newSerId = written.serIds.find((id) => id !== t.serId) ?? null;
      const liveId = newSerId ?? t.serId;
      const rosterDate = this.rosterDate(t);
      live.push({ liveId, rosterDate, subKey: t.subKey });
      touchedAll.push(...written.serIds);
      const students = (await m.query(
        `SELECT st.name FROM ser_stu ss JOIN stu st ON st.id = ss.student_id WHERE ss.ser_id = $1 AND ${serStuOn('ss', '$2::date')} ORDER BY st.name`,
        [liveId, rosterDate],
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
    const parentNoticeIds: number[] = [];
    for (const [i, s] of series.entries()) {
      const { liveId, rosterDate } = live[i]!;
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
        [liveId, rosterDate, body],
      )) as Array<{ id: string }>;
      parentNotices += rows.length;
      parentNoticeIds.push(...rows.map((row) => Number(row.id)));
    }

    /* ── ④ 교재 이관 — 이전 강사 소유 배정만 · 다른 강사/legacy 배정은 추정하지 않는다 ── */
    const bookRows = await this.transferBooks(m, userId, dto, from, to, live);

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
    const notificationIds: number[] = [];
    const link = `/schedule?date=${dto.date}`;
    for (const [who, text, title] of [
      // 새 강사에게는 **누구에게서** 넘겨받는지도 적는다 — 「이전 강사 → 교체 강사」 readback 의 첫 줄 (TEACHER-LINEAGE 2026-09-29)
      [to.id, `강사 교체 — ${from.name} → ${to.name} · ${what} · ${when} · 회차 ${occurrences}회를 맡습니다${dto.memo ? ` · ${dto.memo.trim()}` : ''}`, NOTI_TITLE.teacherChange],
      [from.id, `담당 이관 — ${what} · ${when} → ${to.name}`, NOTI_TITLE.teacherHandover],
    ] as Array<[number, string, string]>) {
      if (who === userId) continue;
      const rows = (await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title) SELECT $1, $2, $3, $4, 'schedule', $5 FROM staff WHERE id = $1 AND active RETURNING id`,
        [who, userId, text, link, title],
      )) as Array<{ id: string }>;
      notifiedTeachers += rows.length;
      notificationIds.push(...rows.map((row) => Number(row.id)));
    }
    const staffRows = (await m.query(
      `INSERT INTO noti (to_id, from_id, body, link, category, title)
       SELECT id, $1, $2, $3, 'etc', $6 FROM staff WHERE active AND role <> 'teacher' AND id <> $1 AND id <> $4 AND id <> $5 RETURNING id`,
      [userId, `강사 교체 — ${from.name} → ${to.name} · ${what} · ${when}${cplRow ? ` · 컴플레인 #${cplRow.id}` : ''}`,
        cplRow ? '/ops?tab=complaint' : link, from.id, to.id, NOTI_TITLE.teacherChange],
    )) as Array<{ id: string }>;
    const notifiedStaff = staffRows.length;
    notificationIds.push(...staffRows.map((row) => Number(row.id)));

    /* ── 컴플레인 도장 · LOG ── */
    let cpl: TeacherChangeResultDto['cpl'] = null;
    let complaintUndo: TeacherChangeUndoPayload['complaint'] = null;
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
      const [afterComplaint] = (await m.query(
        `SELECT stage,teacher_changed,owner_id,action FROM cpl WHERE id=$1`, [cplRow.id],
      )) as Array<{ stage: string; teacher_changed: boolean; owner_id: string | null; action: string | null }>;
      complaintUndo = {
        id: cplRow.id,
        before: { stage: cplRow.stage, teacherChanged: cplRow.teacherChanged, ownerId: cplRow.ownerId, action: cplRow.action },
        after: {
          stage: afterComplaint.stage, teacherChanged: Boolean(afterComplaint.teacher_changed),
          ownerId: afterComplaint.owner_id == null ? null : Number(afterComplaint.owner_id), action: afterComplaint.action,
        },
      };
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
      { key: 'guide', label: '안내 초안', count: guideIds.length, note: guideIds.length ? '학생마다 강사 교체 안내 초안 — 수업 안내에서 다듬어 보냅니다' : '새로 만들 초안이 없습니다(이미 있음)' },
      { key: 'parent', label: '학부모 안내', count: parentNotices, note: '보낼 안내로 남겼습니다 — 학부모 수신처는 아직 없습니다' },
      { key: 'book', label: dto.mode === 'from' ? '교재 이관' : '교재 유지', count: bookRows.length, note: bookRows.length
        ? dto.mode === 'from'
          ? `이전 강사 소유 배정 ${bookRows.length}권 — ${preview ? '확정 시 새 강사에게 이관합니다' : '새 강사에게 이관했습니다'}`
          : `하루 대강은 교재 담당을 바꾸지 않습니다 — 이전 강사 배정 ${bookRows.length}권 유지`
        : '대상 교재 배정이 없습니다' },
      { key: 'payout', label: '정산 시수', count: occurrences, note: payout.length ? payout.map((p) => `${+p.month.slice(5)}월 ${p.occurrences}회 → ${to.name}${p.fromConfirmed || p.toConfirmed ? ' (확정된 달 — 되돌리지 않습니다)' : ''}`).join(' · ') : '옮겨 간 회차가 없습니다' },
      { key: 'notify', label: '선생님 전달', count: notifiedTeachers, note: `새 강사 ${to.name}${from.active && from.id !== userId ? ` · 원래 강사 ${from.name}` : ''} · 관리자 ${notifiedStaff}명` },
    ];
    const result: TeacherChangeResultDto = {
      preview, mode: dto.mode, date: dto.date, fromTeacher: from, toTeacher: to, series, occurrences,
      guideDrafts: guideIds.length, parentNotices, books: bookRows, payout, notifiedTeachers, notifiedStaff, unavailable, cpl, steps,
      scope, requiresWholeClass, version: inspection.version, actor: { id: actor.id, name: actor.name },
      assets: {
        series: series.length, occurrences, guideDrafts: guideIds.length, parentNotices, books: bookRows.length,
        notifications: notifiedTeachers + notifiedStaff, complaints: cpl ? 1 : 0,
      },
      requestKey: preview ? null : dto.requestKey!, rowVersion: preview ? null : 1, undoAvailable: !preview,
    };
    return {
      result,
      undo: {
        scheduleTokens,
        guideIds: guideIds.map(Number),
        parentNoticeIds,
        notificationIds,
        books: bookRows.filter((book) => book.transferred).map((book) => ({
          issueId: book.issueId, fromTeacherId: from.id, toTeacherId: to.id,
          appliedVersion: inspection.bookVersions.get(book.issueId)! + 1,
        })),
        complaint: complaintUndo,
      },
    };
  }

  private async staff(m: EntityManager, id: number): Promise<TcStaffDto> {
    const [st] = (await m.query(`SELECT id, name, active FROM staff WHERE id = $1`, [id])) as Array<{ id: string; name: string; active: boolean }>;
    if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: `구성원 ${id} 을(를) 찾을 수 없습니다` });
    return { id: Number(st.id), name: st.name, active: Boolean(st.active) };
  }

  /**
   * BO-12C 권고안: preview/apply가 같은 SER 번호만 비교하면 명단·회차 예외·교재 담당 변경을 놓친다.
   * 그래서 실제 교체 입력이 읽는 수업/회차/실효 명단/활성 교재 version/컴플레인 상태를 정렬한 뒤 하나의 불투명 sha256으로 묶는다.
   * 정책을 바꿀 때는 DTO/OpenAPI/generated Front, TeacherChangeWizard, operation migration/DBML, BO-12C 시나리오와 portfolio를 함께 갱신한다.
   */
  private async inspectTargets(
    m: EntityManager,
    targets: Target[],
    dto: TeacherChangeDto,
    fromId: number,
    toId: number,
    cpl: { id: number; stage: string; studentId: number | null; teacherChanged: boolean; ownerId: number | null; action: string | null } | null,
  ): Promise<{
    version: string;
    rosters: Array<{ serId: number; onDate: string; studentIds: number[] }>;
    bookVersions: Map<number, number>;
  }> {
    const rosters: Array<{ serId: number; onDate: string; studentIds: number[] }> = [];
    for (const target of targets) {
      const rows = (await m.query(
        `SELECT ss.student_id FROM ser_stu ss WHERE ss.ser_id=$1 AND ${serStuOn('ss', '$2::date')} ORDER BY ss.student_id`,
        [target.serId, target.onDate],
      )) as Array<{ student_id: string }>;
      rosters.push({ serId: target.serId, onDate: target.onDate, studentIds: rows.map((row) => Number(row.student_id)) });
    }
    const studentIds = [...new Set(rosters.flatMap((roster) => roster.studentIds))].sort((a, b) => a - b);
    const subKeys = [...new Set(targets.flatMap((target) => target.subKey ? [target.subKey] : []))].sort();
    const books = studentIds.length && subKeys.length
      ? (await m.query(
        `SELECT id,student_id,teacher_id,sub_key,state,row_version FROM issue
          WHERE student_id=ANY($1) AND sub_key=ANY($2) AND ${issueActiveSql('issue')} ORDER BY id`,
        [studentIds, subKeys],
      )) as Array<{ id: string; student_id: string; teacher_id: string | null; sub_key: string; state: string; row_version: number }>
      : [];
    const bookVersions = new Map(books.map((book) => [Number(book.id), Number(book.row_version)]));
    const occurrenceRows = (await m.query(
      `SELECT o.ser_id,to_char(o.on_date,'YYYY-MM-DD') AS on_date,to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS cal_date,
              o.canceled,${TEACHER_OF} AS teacher_id,s.teacher_id AS series_teacher_id,s.from_date,s.to_date,s.rrule,s.start_min,s.end_min
         FROM ser_occ o JOIN ser s ON s.id=o.ser_id
        WHERE (o.ser_id,o.on_date) IN (SELECT x.ser_id,x.on_date FROM jsonb_to_recordset($1::jsonb) x(ser_id bigint,on_date date))
        ORDER BY o.ser_id,o.on_date`,
      [JSON.stringify(targets.map((target) => ({ ser_id: target.serId, on_date: target.onDate })))],
    )) as unknown[];
    const state = {
      command: { fromId, toId, mode: dto.mode, date: dto.date, serIds: dto.serIds ? [...dto.serIds].sort((a, b) => a - b) : null },
      targets: targets.map((target) => ({ ...target })),
      occurrences: occurrenceRows,
      rosters,
      books: books.map((book) => ({
        id: Number(book.id), studentId: Number(book.student_id), teacherId: book.teacher_id == null ? null : Number(book.teacher_id),
        subKey: book.sub_key, state: book.state, version: Number(book.row_version),
      })),
      complaint: cpl,
    };
    return { version: sha256(state), rosters, bookVersions };
  }

  /**
   * 실효 회차의 **명단 기준일** — 이 서비스의 학생 명단 · 학부모 안내(PNOTI 키) · 교재 대상이 전부 이 값 하나를 쓴다 (CR-BE-01).
   *
   * 값은 **규칙 날짜**(`ser_occ.on_date` = EXC 키)다. 옮긴 회차(달력 날짜 ≠ 규칙 날짜)도 명단은 옮기기 전 그 회차의 날로 판정한다 —
   * 투영(`schedule.project`)·수업 상세·청구(`invoice-lines`)·정산(`payout-sheet`)·안내 초안(`draftsForTeacherChange`)이 전부
   * `serStuOn(ss, o.on_date)` 이고, 이 서비스만 교재를 달력 날짜(`lower(o.span)`)로 세어 명단 경계를 넘어 옮긴 회차에서 두 집합이 갈렸다.
   * 달력 날짜(`calDate`)는 사람에게 보이는 「첫 바뀐 회차 날짜」(`firstOn`)로만 쓴다.
   */
  private rosterDate(t: Pick<Target, 'onDate'>): string { return t.onDate; }

  /**
   * 관리자 수정사항 122~124장 권고안: 영구 교체만 학생×교재×강사×과목 배정 소유자를 넘긴다.
   * ISSUE에는 규칙 id가 없으므로 같은 학생·과목을 이전 강사가 다른 미래 규칙에서도 계속 맡는 경우에는 자동 추정하지 않고 409로 막는다.
   * 정책을 바꿀 때는 BOC-08D-03 문서·TcBookDto·TeacherChangeWizard·teacher-lineage DB 회귀를 함께 수정한다.
   */
  private async transferBooks(
    m: EntityManager,
    userId: number,
    dto: TeacherChangeDto,
    from: TcStaffDto,
    to: TcStaffDto,
    live: LiveTarget[],
  ): Promise<TcBookDto[]> {
    const bookTargets = live
      .filter((target): target is LiveTarget & { subKey: string } => target.subKey !== null)
      .map((target) => ({ ser_id: target.liveId, on_date: target.rosterDate, sub_key: target.subKey }));
    if (!bookTargets.length) return [];

    const params = [JSON.stringify(bookTargets), from.id, from.name];
    const selectSql = (lock: boolean) => `WITH target AS (
         SELECT x.ser_id, x.on_date, x.sub_key
           FROM jsonb_to_recordset($1::jsonb) AS x(ser_id bigint, on_date date, sub_key varchar(20))
       )
       SELECT $2::bigint AS teacher_id, $3::text AS teacher_name,
              st.id AS student_id, st.name AS student_name,
              i.id AS issue_id, l.id AS lib_id, l.title, i.state, i.sub_key, i.row_version
         FROM issue i
         JOIN stu st ON st.id=i.student_id
         JOIN lib l ON l.id=i.lib_id
        WHERE i.teacher_id=$2 AND ${issueActiveSql('i')}
          AND EXISTS (
            SELECT 1 FROM target t
            JOIN ser_stu ss ON ss.ser_id=t.ser_id AND ss.student_id=i.student_id AND ${serStuOn('ss', 't.on_date')}
            WHERE i.sub_key=t.sub_key
          )
        ORDER BY st.name,l.title,i.id${lock ? ' FOR UPDATE OF i' : ''}`;

    let books = (await m.query(selectSql(false), params)) as BookAssignmentRow[];
    if (dto.mode === 'day' || !books.length) {
      return books.map((book) => this.bookDto(book, from, from, false));
    }

    // 교재 배정 writer와 같은 학생+교재 advisory lock을 먼저 잡아 새 배정/다른 교체와 직렬화한다.
    const lockKeys = [...new Set(books.map((book) => `${book.student_id}:${book.lib_id}`))].sort();
    for (const key of lockKeys) {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`book-active:${key}`]);
    }
    books = (await m.query(selectSql(true), params)) as BookAssignmentRow[];
    if (!books.length) return [];

    const issueIds = books.map((book) => Number(book.issue_id));
    const [ambiguous] = (await m.query(
      `SELECT i.id FROM issue i
        WHERE i.id=ANY($1) AND EXISTS (
          SELECT 1 FROM ser s JOIN kind k ON k.key=s.kind_key AND k.grp='lesson'
          JOIN ser_stu ss ON ss.ser_id=s.id AND ss.student_id=i.student_id
          WHERE s.teacher_id=$2 AND s.sub_key=i.sub_key
            AND GREATEST(s.from_date,COALESCE(ss.from_date,s.from_date),$3::date)
                <= LEAST(COALESCE(s.to_date,'infinity'::date),COALESCE(ss.to_date,'infinity'::date))
        ) ORDER BY i.id LIMIT 1`,
      [issueIds, from.id, dto.date],
    )) as Array<{ id: string }>;
    if (ambiguous) {
      throw new ConflictException({
        code: 'BOOK_ASSIGNMENT_TRANSFER_AMBIGUOUS',
        message: '이전 강사가 같은 학생·과목의 다른 수업을 계속 맡고 있어 교재 담당을 자동으로 정할 수 없습니다',
        issueId: Number(ambiguous.id),
      });
    }
    const [collision] = (await m.query(
      `SELECT old_i.id FROM issue old_i WHERE old_i.id=ANY($1) AND EXISTS (
         SELECT 1 FROM issue new_i
          WHERE new_i.student_id=old_i.student_id AND new_i.lib_id=old_i.lib_id
            AND new_i.teacher_id=$2 AND new_i.sub_key=old_i.sub_key AND ${issueActiveSql('new_i')}
       ) ORDER BY old_i.id LIMIT 1`,
      [issueIds, to.id],
    )) as Array<{ id: string }>;
    if (collision) {
      throw new ConflictException({
        code: 'BOOK_ASSIGNMENT_TRANSFER_CONFLICT',
        message: '새 강사에게 같은 학생·교재 배정이 이미 있어 자동 이관할 수 없습니다',
        issueId: Number(collision.id),
      });
    }

    await m.query(`UPDATE issue SET teacher_id=$2,row_version=row_version+1 WHERE id=ANY($1)`, [issueIds, to.id]);
    for (const book of books) {
      await m.query(histSql(), ['issue', Number(book.issue_id), 'teacher_swap', userId]);
      await m.query(
        `INSERT INTO log(actor_id,entity,entity_id,action,before,after)
         VALUES ($1,'ISSUE',$2,'teacher-change',$3::jsonb,$4::jsonb)`,
        [userId, Number(book.issue_id),
          JSON.stringify({ teacherId: from.id, subKey: book.sub_key, rowVersion: Number(book.row_version) }),
          JSON.stringify({ teacherId: to.id, date: dto.date, mode: dto.mode, rowVersion: Number(book.row_version) + 1 })],
      );
    }
    return books.map((book) => this.bookDto(book, from, to, true));
  }

  private bookDto(book: BookAssignmentRow, previous: TcStaffDto, current: TcStaffDto, transferred: boolean): TcBookDto {
    return {
      previousTeacherId: previous.id,
      previousTeacherName: previous.name,
      teacherId: current.id,
      teacherName: current.name,
      studentId: Number(book.student_id),
      studentName: book.student_name,
      issueId: Number(book.issue_id),
      libId: Number(book.lib_id),
      title: book.title,
      state: book.state,
      transferred,
    };
  }

  /** 대상 회차 — day: 그날의 회차 하나씩 · from: 규칙마다 그 날 이후 첫 회차 (patch 의 onDate = 규칙 날짜) */
  private async targets(m: EntityManager, dto: TeacherChangeDto, fromId: number, studentId: number | null): Promise<Target[]> {
    const rows = (await m.query(
      `SELECT DISTINCT ON (o.ser_id) o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS cal_date,
              s.title, k.name AS kind_name, s.sub_key, sb.name AS sub_name, s.rrule, s.start_min, s.end_min
         FROM ser_occ o JOIN ser s ON s.id = o.ser_id JOIN kind k ON k.key = s.kind_key LEFT JOIN sub sb ON sb.key = s.sub_key
        WHERE NOT o.canceled
          /* day 는 그날 실제로 맡는 사람(대강 예외 포함) · from 은 규칙의 강사 — 남의 규칙에 잠깐 대강으로 든 회차 때문에 그 규칙을 통째로 가르지 않는다 */
          AND (($2::boolean AND ${kstDateOf('lower(o.span)')} = $3::date AND ${TEACHER_OF} = $1)
            OR (NOT $2::boolean AND o.on_date >= $3::date AND s.teacher_id = $1))
          AND ($4::bigint[] IS NULL OR o.ser_id = ANY($4))
          AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ss.student_id = $5 AND ${serStuOn('ss', 'o.on_date')}))
        ORDER BY o.ser_id, o.on_date, o.id`,
      [fromId, dto.mode === 'day', dto.date, dto.serIds?.length ? dto.serIds : null, studentId],
    )) as Array<{ ser_id: string; on_date: string; cal_date: string; title: string; kind_name: string; sub_key: string | null; sub_name: string | null; rrule: string; start_min: number; end_min: number }>;
    return rows.map((r) => ({
      serId: Number(r.ser_id), onDate: r.on_date, calDate: r.cal_date, title: String(r.title ?? ''), kindName: r.kind_name, subKey: r.sub_key ?? null, subName: r.sub_name ?? null,
      rrule: r.rrule, startMin: Number(r.start_min), endMin: Number(r.end_min),
    }));
  }
}
