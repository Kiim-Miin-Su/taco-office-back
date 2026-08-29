import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SerOcc } from '../../entities';
import { isWrittenDbState } from '../../lib/rules';
import type { RepStateT } from '../../entities/enums';
import type { OccurrenceDto } from './schedule.dto';

export interface OccQuery {
  from: string;
  to: string;
  teacherId?: number;
  studentId?: number;
  roomId?: number;
}

/** DB 가 돌려준 한 줄 — 컬럼 이름은 아래 SQL 과 짝이다 */
interface Row {
  ser_id: string; on_date: string; start_min: number; end_min: number;
  kind_key: string; sub_key: string | null; title: string | null;
  teacher_id: string | null; teacher_name: string | null;
  room_id: string | null; room_name: string | null;
  zacc_id: string | null; mode: string; canceled: boolean;
  has_exception: boolean; rep_state: string | null;
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
    const cond: string[] = ['o.on_date BETWEEN $1 AND $2'];
    if (q.teacherId) { params.push(q.teacherId); cond.push(`o.teacher_id = $${params.length}`); }
    if (q.roomId) { params.push(q.roomId); cond.push(`o.room_id = $${params.length}`); }
    if (q.studentId) {
      params.push(q.studentId);
      cond.push(`EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ss.student_id = $${params.length})`);
    }

    const rows = (await this.occ.query(
      // 시각은 **회차(span)** 에서 뽑는다. 규칙(ser)에서 뽑으면 「이번만 시간 옮김」 예외가
      // 화면에 반영되지 않는다 — 예외를 승인해 놓고 시간표는 원래 시각을 보여 주게 된다.
      `SELECT o.ser_id, to_char(o.on_date, 'YYYY-MM-DD') AS on_date,
              (EXTRACT(HOUR FROM lower(o.span) AT TIME ZONE 'Asia/Seoul') * 60
               + EXTRACT(MINUTE FROM lower(o.span) AT TIME ZONE 'Asia/Seoul'))::int AS start_min,
              (EXTRACT(HOUR FROM upper(o.span) AT TIME ZONE 'Asia/Seoul') * 60
               + EXTRACT(MINUTE FROM upper(o.span) AT TIME ZONE 'Asia/Seoul'))::int AS end_min,
              s.kind_key, s.sub_key, s.title, s.mode,
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
         LEFT JOIN staff t ON t.id = o.teacher_id
         LEFT JOIN room rm ON rm.id = o.room_id
         LEFT JOIN exc e   ON e.ser_id = o.ser_id AND e.on_date = o.on_date
         LEFT JOIN rep r   ON r.ser_id = o.ser_id AND r.on_date = o.on_date
        WHERE ${cond.join(' AND ')}
        ORDER BY o.on_date, s.start_min, o.ser_id`,
      params,
    )) as Row[];

    return rows.map((r) => {
      // 내려보내는 값은 **DB 어휘 그대로**다 (DTO 가 그렇게 적혀 있고 화면이 그걸 읽는다).
      // 규칙 어휘로 옮기는 것은 판정할 때뿐이다 — 옮기는 자리는 rules.ts 한 곳이다.
      const repState = (r.rep_state ?? 'na') as RepStateT;
      return {
        serId: Number(r.ser_id),
        date: r.on_date,
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
        repState,
        // 판정은 rules.ts 한 곳에서만 한다 — 화면도 서버도 여기서 나온 값을 읽기만 한다
        written: isWrittenDbState(r.rep_state),
        students: (r.students ?? []).map((s) => ({
          id: Number(s.id), name: s.name, grade: s.grade, droppedOnce: Boolean(s.droppedOnce),
        })),
      };
    });
  }
}
