/** @file-guide
 * 목적: schedule.service.ts — OccQuery, ScheduleService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SerOcc } from '../../entities';
import {
  GUIDE_DONE_DB, REPORT_WRITTEN_DB,
  canEditAttendance, effectiveRepStateFromEnded, isPast, isWrittenDbState, rosterPricing, tierFor,
  type AttendanceCancelReason, type AttendanceResult,
} from '../../lib/rules';
import { isRecurring, type Ser } from '../../lib/recurrence';
import type {
  LessonTrackingDto, OccurrenceDto, OccurrenceQueryDto, TrackedReportDto, TrackedStudentDto,
} from './schedule.dto';
import { START_MIN, END_MIN, kstDateOf, spanOf } from '../../lib/sql';
import { nowMinKst, todayKst } from '../../lib/kst';

export interface OccQuery extends OccurrenceQueryDto {
  canCrudAttendance?: boolean;
}

/** DB 가 돌려준 한 줄 — 컬럼 이름은 아래 SQL 과 짝이다 */
interface Row {
  ser_id: string; date: string; on_date: string; start_min: number; end_min: number;
  kind_key: string; sub_key: string | null; title: string | null;
  rrule: string; ser_from: string; ser_to: string | null;
  teacher_id: string | null; teacher_name: string | null;
  room_id: string | null; room_name: string | null;
  zacc_id: string | null; mode: string; canceled: boolean;
  has_exception: boolean; reportable: boolean; rep_state: string | null;
  attendance_id: string | null; attendance_result: AttendanceResult | null;
  attendance_reason: AttendanceCancelReason | null; attendance_confirmed_by: string | null;
  attendance_confirmed_by_name: string | null; attendance_confirmed_at: Date | string | null;
  students: Array<{ id: number; name: string; grade: string | null; droppedOnce: boolean }> | null;
}

@Injectable()
export class ScheduleService {
  constructor(@InjectRepository(SerOcc) private readonly occ: Repository<SerOcc>) {}

  private q<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.occ.query(sql, p) as Promise<T[]>;
  }

  /**
   * 회차 목록. 화면 다섯이 이 하나를 쓰고 **묶는 방법만 다르다**.
   *
   * 리포트 상태를 여기서 함께 내려보내는 이유: 캘린더 블록 색이 그 값이기 때문이다.
   * 화면이 리포트를 따로 부르면 N+1 이 되고, 색이 늦게 칠해진다.
   */
  async list(q: OccQuery): Promise<OccurrenceDto[]> {
    const params: unknown[] = [q.from, q.to];
    // 표시 범위는 EXC 키(on_date)가 아니라 실제 span 날짜로 자른다. 다른 날로 옮긴 회차가
    // 원래 날에 남거나 새 날 조회에서 빠지면 date/onDate 두 칸을 둔 이유가 사라진다.
    const cond: string[] = [`${kstDateOf('lower(o.span)')} BETWEEN $1::date AND $2::date`];
    if (q.teacherId) { params.push(q.teacherId); cond.push(`o.teacher_id = $${params.length}`); }
    if (q.roomId) { params.push(q.roomId); cond.push(`o.room_id = $${params.length}`); }
    if (q.studentId) {
      params.push(q.studentId);
      cond.push(`EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ss.student_id = $${params.length})`);
    }

    const rows = (await this.occ.query(
      // 시각은 **회차(span)** 에서 뽑는다. 규칙(ser)에서 뽑으면 「이번만 시간 옮김」 예외가
      // 화면에 반영되지 않는다 — 예외를 승인해 놓고 시간표는 원래 시각을 보여 주게 된다.
      `SELECT o.ser_id,
              to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS date,
              to_char(o.on_date, 'YYYY-MM-DD') AS on_date,
              ${START_MIN} AS start_min,
              ${END_MIN} AS end_min,
              s.kind_key, s.sub_key, s.title, s.mode, k.rep AS reportable,
              s.rrule, to_char(s.from_date, 'YYYY-MM-DD') AS ser_from,
              to_char(s.to_date, 'YYYY-MM-DD') AS ser_to,
              o.teacher_id, t.name AS teacher_name,
              o.room_id, rm.name AS room_name, o.zacc_id, o.canceled,
              (e.id IS NOT NULL) AS has_exception,
              r.state AS rep_state,
              a.id AS attendance_id, a.result AS attendance_result, a.reason AS attendance_reason,
              a.confirmed_by AS attendance_confirmed_by,
              ac.name AS attendance_confirmed_by_name,
              a.confirmed_at AS attendance_confirmed_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', st.id, 'name', st.name, 'grade', st.grade,
                         -- 그날만 빠진 학생은 지우지 않고 표시만 한다 (D-R21)
                         'droppedOnce', EXISTS (
                           SELECT 1 FROM exc_stu_out xo
                            WHERE xo.exc_id = e.id AND xo.student_id = st.id)
                       ) ORDER BY st.id)
                FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                WHERE ss.ser_id = o.ser_id
              ), '[]'::json) AS students
         FROM ser_occ o
         JOIN ser s   ON s.id = o.ser_id
         JOIN kind k  ON k.key = s.kind_key
         LEFT JOIN staff t ON t.id = o.teacher_id
         LEFT JOIN room rm ON rm.id = o.room_id
         LEFT JOIN exc e   ON e.ser_id = o.ser_id AND e.on_date = o.on_date
         LEFT JOIN rep r   ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         LEFT JOIN att a   ON a.ser_id = o.ser_id AND a.on_date = o.on_date
         LEFT JOIN staff ac ON ac.id = a.confirmed_by
        WHERE ${cond.join(' AND ')}
        -- **회차의 시각**으로 정렬한다. 규칙(ser.start_min)으로 정렬하면
        -- 「이번만 시간 옮김」한 수업이 옮기기 전 자리에 그려진다 — 시각은 span 에서 뽑아 놓고
        -- 순서만 규칙을 보던 자리였다.
        ORDER BY o.on_date, lower(o.span), o.ser_id`,
      params,
    )) as Row[];

    const today = todayKst();
    const nowMin = nowMinKst();
    return rows.map((r) => {
      const when = { date: r.date, startMin: r.start_min, durationMin: r.end_min - r.start_min };
      // 「끝났는가」를 먼저 한 번 구해서 리포트 상태와 DTO 가 **같은 값**을 쓴다.
      // 두 번 구하면 자정·수업 종료 순간에 둘이 갈린다.
      const ended = isPast(when, today, nowMin);
      // na/plan/none 은 회차 시각에서 파생한다. 오래된 잘못된 시드와 리포트 행이 없는
      // 신규 수업도 같은 규칙을 타므로 화면마다 상태가 갈라지지 않는다.
      const repState = effectiveRepStateFromEnded(
        r.rep_state,
        r.reportable && r.attendance_result !== 'canceled',
        ended,
      );
      return {
        serId: Number(r.ser_id),
        // 그릴 날짜와 EXC 키를 **둘 다** 내려보낸다. 옮긴 회차는 둘이 다르고,
        // 쓰기는 원래 날짜로만 예외를 찾는다.
        date: r.date,
        onDate: r.on_date,
        startMin: r.start_min,
        endMin: r.end_min,
        kindKey: r.kind_key,
        subKey: r.sub_key,
        title: r.title,
        teacherId: r.teacher_id ? Number(r.teacher_id) : null,
        teacherName: r.teacher_name,
        roomId: r.room_id ? Number(r.room_id) : null,
        roomName: r.room_name,
        zaccId: r.zacc_id ? Number(r.zacc_id) : null,
        mode: r.mode,
        canceled: r.canceled,
        hasException: r.has_exception,
        // 「물어야 하는가」는 규칙이 정한다 — 화면은 이 값만 본다 (§5A.0). 남은 회차는
        // **이 회차의 날짜부터** 센다: 마지막 한 회만 남은 반복은 단발처럼 바로 저장한다.
        recurring: isRecurring(
          { rrule: r.rrule, fromDate: r.ser_from, toDate: r.ser_to } as Ser,
          r.on_date,
        ),
        repState,
        ended,
        // 판정은 rules.ts 한 곳에서만 한다 — 화면도 서버도 여기서 나온 값을 읽기만 한다
        written: isWrittenDbState(repState),
        attendanceMode: canEditAttendance(
          { ...when, canceled: r.canceled },
          { canCrudAttendance: q.canCrudAttendance ?? false, today, nowMin },
        ),
        attendance: r.attendance_id == null ? null : {
          id: Number(r.attendance_id),
          result: r.attendance_result!,
          reason: r.attendance_reason,
          confirmedBy: Number(r.attendance_confirmed_by),
          confirmedByName: r.attendance_confirmed_by_name!,
          confirmedAt: new Date(r.attendance_confirmed_at!).toISOString(),
          countsForPay: r.attendance_result === 'completed',
        },
        students: (r.students ?? []).map((s) => ({
          id: Number(s.id), name: s.name, grade: s.grade, droppedOnce: Boolean(s.droppedOnce),
        })),
      };
    });
  }

  /**
   * 겹침 미리보기 — **누구와 겹치는지**를 돌려준다 (§19).
   *
   * DB 의 EXCLUDE 가 어차피 막지만(D-R43), 409 만 던지면 화면은 「안 됩니다」밖에 못 쓴다.
   * 사람이 시간을 고치려면 *무엇과* 겹치는지를 알아야 한다. 막는 것은 DB 가, 설명은 여기가 한다 —
   * 여기서 통과했다고 저장을 건너뛰지 않는다. 이 사이에 남이 잡을 수 있기 때문이다.
   */
  async conflicts(q: {
    onDate: string; startMin: number; endMin: number;
    teacherId?: number | null; roomId?: number | null; zaccId?: number | null;
    exceptSerId?: number | null;
  }): Promise<Array<{ serId: number; onDate: string; startMin: number; endMin: number; title: string | null; with: 'teacher' | 'room' | 'zoom'; whoName: string | null }>> {
    const who: Array<['teacher' | 'room' | 'zoom', string, number]> = [];
    if (q.teacherId) who.push(['teacher', 'o.teacher_id', q.teacherId]);
    if (q.roomId) who.push(['room', 'o.room_id', q.roomId]);
    if (q.zaccId) who.push(['zoom', 'o.zacc_id', q.zaccId]);
    if (who.length === 0) return [];

    const out: Array<{ serId: number; onDate: string; startMin: number; endMin: number; title: string | null; with: 'teacher' | 'room' | 'zoom'; whoName: string | null }> = [];
    for (const [label, col, id] of who) {
      const rows = (await this.occ.query(
        // 겹침의 정의는 **DB 의 EXCLUDE 와 같은 것**을 쓴다 (`span &&`).
        // 분으로 되돌려 비교하면 자정을 넘는 회차에서 둘의 답이 갈린다.
        `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
                ${START_MIN} AS start_min,
                ${END_MIN} AS end_min,
                COALESCE(s.title, k.name) AS title,
                CASE WHEN $5 = 'teacher' THEN t.name WHEN $5 = 'room' THEN rm.name ELSE z.label END AS who_name
           FROM ser_occ o
           JOIN ser s ON s.id = o.ser_id
           LEFT JOIN kind k ON k.key = s.kind_key
           LEFT JOIN staff t ON t.id = o.teacher_id
           LEFT JOIN room rm ON rm.id = o.room_id
           LEFT JOIN zacc z ON z.id = o.zacc_id
          WHERE NOT o.canceled
            AND ${col} = $1
            AND o.span && ${spanOf('$2', '$3', '$4')}
            AND ($6::bigint IS NULL OR o.ser_id <> $6)
          ORDER BY lower(o.span)`,
        [id, q.onDate, q.startMin, q.endMin, label, q.exceptSerId ?? null],
      )) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.push({
          serId: Number(r.ser_id), onDate: String(r.on_date),
          startMin: Number(r.start_min), endMin: Number(r.end_min),
          title: r.title === null || r.title === undefined ? null : String(r.title),
          with: label, whoName: r.who_name === null || r.who_name === undefined ? null : String(r.who_name),
        });
      }
    }
    return out;
  }

  /* ══ §79 수강 학생 — 학생 트래킹 (C55) ═════════════════════════════════ */

  /**
   * 원문 §79 의 오른쪽 칸. 학생마다 교재·안내·30일 출결·미수와 **최신 리포트 3건**을 싣는다.
   *
   * 회차 목록에 끼워 넣지 않는 이유: 한 주치 회차마다 학생별 질의가 붙는다.
   * 이 창은 눌러야 열리므로 **열 때 한 번** 부른다.
   *
   * 「진도 평균」은 **싣지 않았다.** 원문 카드에 있지만 저장할 자리가 없고(교재 진도를 적는 칸이
   * `issue` 에도 `lib` 에도 없다), 원문 컷의 값이 두 학생 모두 0% 라 무엇을 나눈 값인지도
   * 말해 주지 않는다. 숫자를 지어내면 그 자리부터 거짓이 된다 — N-31 로 올렸다.
   */
  async tracking(
    serId: number,
    onDate: string,
    canSeeAmounts: boolean,
  ): Promise<LessonTrackingDto | null> {
    const today = todayKst();

    const [head] = (await this.q(
      `SELECT s.id, s.kind_key, s.sub_key, k.cap,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', st.id, 'name', st.name, 'grade', st.grade,
                  'droppedOnce', EXISTS (
                    SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                     WHERE e.ser_id = s.id AND e.on_date = $2::date AND xo.student_id = st.id
                  )
                ) ORDER BY st.name)
                FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
               WHERE ss.ser_id = s.id
              ), '[]'::json) AS students
         FROM ser s JOIN kind k ON k.key = s.kind_key
        WHERE s.id = $1`,
      [serId, onDate],
    )) as Array<Record<string, unknown>>;
    if (!head) return null;

    const roster = (head.students ?? []) as Array<{
      id: number; name: string; grade: string | null; droppedOnce: boolean;
    }>;
    const active = roster.filter((r) => !r.droppedOnce);
    const ids = roster.map((r) => r.id);
    const cap = Number(head.cap);
    const count = active.length;
    const canAdd = Math.max(0, cap - count);

    // 가격은 명단 쓰기 응답과 **같은 함수**에서 나온다 (lib/rules.rosterPricing · §54 · D-R22)
    const tiers = (await this.q(
      `SELECT DISTINCT ON (heads) heads, unit_price
         FROM rate
        WHERE kind_key = $1 AND sub_key IS NOT DISTINCT FROM $2 AND from_date <= $3
        ORDER BY heads, from_date DESC, id DESC`,
      [head.kind_key, head.sub_key ?? null, onDate],
    )) as Array<{ heads: number; unit_price: number }>;
    const overrides = active.length ? (await this.q(
      `SELECT DISTINCT ON (st.id) st.id, r.unit_price
         FROM stu st
         LEFT JOIN sturate r
           ON r.student_id = st.id AND (r.kind_key IS NULL OR r.kind_key = $2) AND r.from_date <= $3
        WHERE st.id = ANY($1::bigint[])
        ORDER BY st.id, r.from_date DESC NULLS LAST, r.id DESC`,
      [active.map((a) => a.id), head.kind_key, onDate],
    )) as Array<{ unit_price: number | null }> : [];
    const pricing = rosterPricing(
      tiers.map((t) => ({ heads: Number(t.heads), unitPrice: Number(t.unit_price) })),
      overrides.map((o) => (o.unit_price === null || o.unit_price === undefined ? null : Number(o.unit_price))),
    );

    const students: TrackedStudentDto[] = roster.map((r) => ({
      ...r, bookCount: 0, guided: false, attendDone: 0, attendTotal: 0,
      unpaid: canSeeAmounts ? 0 : null, reports: [],
    }));

    if (ids.length > 0) {
      const byId = new Map(students.map((s) => [s.id, s]));

      const facts = (await this.q(
        `SELECT st.id,
                (SELECT count(*) FROM issue i
                  WHERE i.student_id = st.id AND i.returned_on IS NULL) AS book_count,
                EXISTS (
                  SELECT 1 FROM guide g
                   WHERE g.ser_id = $2 AND g.student_id = st.id
                     AND g.state::text = ANY($3::text[])
                ) AS guided,
                -- 30일 출결: **확정된 것만** 센다. 그날 빠진 회차는 분모에도 없다
                (SELECT count(*) FROM att a
                   JOIN ser_stu ss2 ON ss2.ser_id = a.ser_id AND ss2.student_id = st.id
                  WHERE a.on_date > $4::date - 30 AND a.on_date <= $4::date
                    AND NOT EXISTS (
                      SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                       WHERE e.ser_id = a.ser_id AND e.on_date = a.on_date AND xo.student_id = st.id
                    )) AS att_total,
                (SELECT count(*) FROM att a
                   JOIN ser_stu ss2 ON ss2.ser_id = a.ser_id AND ss2.student_id = st.id
                  WHERE a.on_date > $4::date - 30 AND a.on_date <= $4::date
                    AND a.result = 'completed'
                    AND NOT EXISTS (
                      SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                       WHERE e.ser_id = a.ser_id AND e.on_date = a.on_date AND xo.student_id = st.id
                    )) AS att_done,
                COALESCE((SELECT sum(i.amount - i.paid_amount) FROM inv i
                   WHERE i.student_id = st.id AND i.state IN ('sent','unpaid','partial')), 0) AS unpaid
           FROM stu st WHERE st.id = ANY($1::bigint[])`,
        [ids, serId, [...GUIDE_DONE_DB], today],
      )) as Array<Record<string, unknown>>;
      for (const f of facts) {
        const s = byId.get(Number(f.id));
        if (!s) continue;
        s.bookCount = Number(f.book_count);
        s.guided = f.guided === true;
        s.attendTotal = Number(f.att_total);
        s.attendDone = Number(f.att_done);
        // 금액은 대표만 (D-R39) — 0 원과 「가려짐」을 화면이 구분할 수 있게 0 을 null 로 바꾸지 않는다
        s.unpaid = canSeeAmounts ? Number(f.unpaid) : null;
      }

      const reps = (await this.q(
        `SELECT * FROM (
           SELECT rs.student_id, r.id AS rep_id, to_char(r.on_date,'YYYY-MM-DD') AS on_date,
                  COALESCE(sb.name, s.title, k.name) AS subject_name, t.name AS teacher_name,
                  r.body, r.submitted_at,
                  to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_utc,
                  row_number() OVER (PARTITION BY rs.student_id ORDER BY r.on_date DESC, r.id DESC) AS rn
             FROM rep r
             JOIN rep_stu rs ON rs.rep_id = r.id
             JOIN ser s ON s.id = r.ser_id
             JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
             LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
             LEFT JOIN sub sb ON sb.key = s.sub_key
             LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
            WHERE rs.student_id = ANY($1::bigint[]) AND r.state::text = ANY($2::text[])
         ) q WHERE rn <= 3 ORDER BY student_id, on_date DESC`,
        [ids, [...REPORT_WRITTEN_DB]],
      )) as Array<Record<string, unknown>>;
      for (const r of reps) {
        const s = byId.get(Number(r.student_id));
        if (!s) continue;
        s.reports.push(ScheduleService.toTrackedReport(r));
      }
    }

    return {
      serId, onDate, cap, count, canAdd,
      // 원문 머리줄 그대로 — 화면이 cap − count 를 다시 하지 않는다 (D-R37)
      capLabel: canAdd > 0 ? `정원 ${cap}명 · ${canAdd}명 더 넣을 수 있습니다` : `정원 ${cap}명 · 자리가 없습니다`,
      priced: pricing !== null,
      unitPrice: canSeeAmounts && pricing ? pricing.unitPrice : null,
      total: canSeeAmounts && pricing ? pricing.total : null,
      canSeeAmounts,
      students,
    };
  }

  /** 「정시 / 지연」은 `tierFor` 한 곳이 정한다 — 강사 화면의 차감액과 같은 판정이다 (D-R32) */
  private static toTrackedReport(r: Record<string, unknown>): TrackedReportDto {
    const body = (r.body ?? {}) as Record<string, unknown>;
    const end = r.end_utc ? new Date(String(r.end_utc)) : null;
    const submitted = r.submitted_at ? new Date(r.submitted_at as string) : null;
    const after = end && submitted ? Math.floor((submitted.getTime() - end.getTime()) / 60000) : 0;
    const onTime = tierFor(Math.max(0, after)).amount === 0;
    const text = typeof body.content === 'string' ? body.content : null;
    return {
      repId: Number(r.rep_id),
      onDate: String(r.on_date),
      subjectName: (r.subject_name as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      onTime,
      onTimeLabel: onTime ? '정시' : '지연',
      excerpt: text,
      homework: typeof body.homework === 'string' ? body.homework : null,
    };
  }
}
