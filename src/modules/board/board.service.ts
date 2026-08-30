import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { GUIDE_PENDING_DB, REPORT_WRITTEN_DB } from '../../lib/rules';
import type { BoardDto, CheckMarkDto } from './board.dto';
import { hhmmOf } from '../../lib/sql';

type R = Record<string, unknown>;

/**
 * §34 수업 현황판.
 *
 * **아무것도 저장하지 않는다** (D-R4). 교재·안내·줌·리포트 네 마크를 매번 원장에서 다시 센다.
 * 저장해 두면 「교재를 나중에 배부했는데 현황판은 아직 빨간」 상태가 생기고,
 * 그때부터 화면을 아무도 믿지 않게 된다.
 */
@Injectable()
export class BoardService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  async range(from: string, to: string, teacherId?: number): Promise<BoardDto> {
    const rows = await this.q(
      `SELECT o.id AS occ_id, o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
              ${hhmmOf('lower(o.span)')} AS start_at,
              ${hhmmOf('upper(o.span)')} AS end_at,
              s.mode, s.kind_key, k.name AS kind_name,
              t.name AS teacher_name, rm.name AS room_name,
              o.zacc_id,
              /* 그날 빠진 학생은 명단에서 뺀다 (D-R21).
                 스케줄 화면은 exc_stu_out 을 보고 droppedOnce 를 매기는데 여기만 안 보고 있었다 —
                 같은 날 같은 수업의 명단이 두 화면에서 달랐고, 빠진 학생의 교재까지 세고 있었다. */
              COALESCE((SELECT array_agg(st.name ORDER BY st.name)
                          FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                         WHERE ss.ser_id = o.ser_id
                           AND NOT EXISTS (
                                 SELECT 1 FROM exc e
                                   JOIN exc_stu_out eo ON eo.exc_id = e.id
                                  WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date
                                    AND eo.student_id = ss.student_id)), '{}') AS student_names,
              /* 교재 — 이 수업 학생 중 배부받은 사람이 하나라도 있는가 */
              EXISTS (SELECT 1 FROM issue i
                       WHERE i.returned_on IS NULL
                         AND i.student_id IN (SELECT ss.student_id FROM ser_stu ss WHERE ss.ser_id = o.ser_id)
                     ) AS book_done,
              /* 안내 — 이 수업에 아직 안 보낸 안내가 남아 있는가 */
              NOT EXISTS (SELECT 1 FROM guide g WHERE g.ser_id = o.ser_id AND g.state = ANY($4)) AS guide_done,
              /* 리포트 — 이 회차의 리포트가 적혔는가 (D-R7 은 「썼는가」 하나만 본다) */
              EXISTS (SELECT 1 FROM rep r
                       WHERE r.ser_id = o.ser_id AND r.on_date = o.on_date AND r.state = ANY($5)) AS report_done,
              /* 리포트 대상 수업인가 (D-R6) */
              k.rep AS kind_needs_report
         FROM ser_occ o
         JOIN ser  s  ON s.id = o.ser_id
         LEFT JOIN kind  k  ON k.key = s.kind_key
         LEFT JOIN staff t  ON t.id = o.teacher_id
         LEFT JOIN room  rm ON rm.id = o.room_id
        WHERE o.on_date BETWEEN $1::date AND $2::date
          AND ($3::bigint IS NULL OR o.teacher_id = $3)
        ORDER BY o.on_date, lower(o.span), o.id`,
      [from, to, teacherId ?? null, [...GUIDE_PENDING_DB], REPORT_WRITTEN_DB],
    );

    const out = rows.map((r) => {
      const online = r.mode === 'online';
      const needsReport = r.kind_needs_report !== false;

      const marks: CheckMarkDto[] = [
        { key: 'book', done: r.book_done === true, na: false,
          note: r.book_done === true ? null: '배부된 교재가 없다' },
        { key: 'guide', done: r.guide_done === true, na: false,
          note: r.guide_done === true ? null : '안 보낸 안내가 남아 있다' },
        { key: 'zoom', done: online ? r.zacc_id !== null && r.zacc_id !== undefined : false, na: !online,
          note: online ? (r.zacc_id ? null : '줌 계정이 안 붙었다') : '오프라인 수업' },
        { key: 'report', done: r.report_done === true, na: !needsReport,
          note: needsReport ? (r.report_done === true ? null : '리포트가 아직 없다') : '리포트 대상이 아닌 종류' },
      ];

      const missing = marks.filter((m) => !m.na && !m.done).length;

      return {
        occId: Number(r.occ_id), serId: Number(r.ser_id), onDate: String(r.on_date),
        startAt: String(r.start_at), endAt: String(r.end_at),
        teacherName: (r.teacher_name as string) ?? null,
        roomName: (r.room_name as string) ?? null,
        mode: String(r.mode), kindKey: String(r.kind_key),
        kindName: (r.kind_name as string) ?? null,
        studentNames: (r.student_names as string[]) ?? [],
        canceled: r.canceled === true,
        marks,
        missing,
      };
    });

    return {
      from, to,
      rows: out,
      missingCount: out.filter((r) => !r.canceled && r.missing > 0).length,
      computedAt: new Date().toISOString(),
    };
  }
}
