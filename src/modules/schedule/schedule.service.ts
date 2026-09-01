import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SerOcc } from '../../entities';
import { effectiveRepState, isWrittenDbState } from '../../lib/rules';
import { isRecurring, type Ser } from '../../lib/recurrence';
import type { OccurrenceDto } from './schedule.dto';
import { START_MIN, END_MIN, kstDateOf, spanOf } from '../../lib/sql';
import { nowMinKst, todayKst } from '../../lib/kst';

export interface OccQuery {
  from: string;
  to: string;
  teacherId?: number;
  studentId?: number;
  roomId?: number;
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
  students: Array<{ id: number; name: string; grade: string | null; droppedOnce: boolean }> | null;
}

@Injectable()
export class ScheduleService {
  constructor(@InjectRepository(SerOcc) private readonly occ: Repository<SerOcc>) {}

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
      // na/plan/none 은 회차 시각에서 파생한다. 오래된 잘못된 시드와 리포트 행이 없는
      // 신규 수업도 같은 규칙을 타므로 화면마다 상태가 갈라지지 않는다.
      const repState = effectiveRepState(
        r.rep_state,
        { date: r.date, startMin: r.start_min, durationMin: r.end_min - r.start_min },
        r.reportable,
        today,
        nowMin,
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
        // 판정은 rules.ts 한 곳에서만 한다 — 화면도 서버도 여기서 나온 값을 읽기만 한다
        written: isWrittenDbState(repState),
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
}
