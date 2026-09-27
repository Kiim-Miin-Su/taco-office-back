/** @file-guide
 * 목적: board.service.ts — BoardService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { GUIDE_DONE_DB, REPORT_WRITTEN_DB } from '../../lib/rules';
import type { BoardDto, BoardFacetsDto, CheckMarkDto } from './board.dto';
import { effectiveModeOf, hhmmOf, kstDateOf, serStuOn } from '../../lib/sql';
import { GUIDE_EVENT_CTE, guideCoversEvent } from '../guides/guide-events';
import { boardSummary } from './board.rules';

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

  /**
   * 회차마다 **안내가 필요한 학생 수**와 그중 **보낸(sent·read) 안내로 덮인 수** (§34-5).
   *
   * 원문 규칙 줄 「안내는 첫 수업이거나 강사가 바뀐 학생만 '필요'」. 판정은 §45 누락 카드와 같은
   * `GUIDE_EVENT_CTE` · `guideCoversEvent` 한 벌이다 — 현황판이 따로 세면 §45 에는 「안 한 것」인데
   * 현황판은 「해당 없음」인 학생이 생긴다. 필요한 학생이 없으면 해당 없음(na)이다.
   */
  private async guideNeeds(occIds: number[]): Promise<Map<number, { needed: number; sent: number }>> {
    const out = new Map<number, { needed: number; sent: number }>();
    if (occIds.length === 0) return out;
    const rows = await this.q(
      `${GUIDE_EVENT_CTE}
       SELECT e.source_occurrence_id AS occ_id,
              count(*)::int AS needed,
              count(*) FILTER (WHERE ${guideCoversEvent('$2')})::int AS sent
         FROM events e
        WHERE e.reason IS NOT NULL AND e.source_occurrence_id = ANY($1::bigint[])
        GROUP BY e.source_occurrence_id`,
      [occIds, [...GUIDE_DONE_DB]],
    );
    for (const row of rows) out.set(Number(row.occ_id), { needed: Number(row.needed), sent: Number(row.sent) });
    return out;
  }

  /**
   * §34 필터 칩 두 줄 — **그 기간에 나온** 과목·강사만 (원문 「그 기간에 나온 과목·강사만 선다」).
   * 과목·강사 필터를 걸기 **전**의 기간을 센다. 강사 본인 범위(`scopeTeacherId`)만 지킨다.
   */
  private async facets(from: string, to: string, scopeTeacherId?: number): Promise<BoardFacetsDto> {
    const inRange = `${kstDateOf('lower(o.span)')} BETWEEN $1::date AND $2::date
          AND ($3::bigint IS NULL OR o.teacher_id = $3)`;
    const [subjects, teachers] = await Promise.all([
      this.q(
        `SELECT sb.key, sb.name, count(*) FILTER (WHERE NOT o.canceled)::int AS lessons
           FROM ser_occ o JOIN ser s ON s.id = o.ser_id JOIN sub sb ON sb.key = s.sub_key
          WHERE ${inRange}
          GROUP BY sb.key, sb.name, sb.sort
          ORDER BY sb.sort NULLS LAST, sb.name, sb.key`,
        [from, to, scopeTeacherId ?? null],
      ),
      this.q(
        `SELECT t.id, t.name, count(*) FILTER (WHERE NOT o.canceled)::int AS lessons
           FROM ser_occ o JOIN staff t ON t.id = o.teacher_id
          WHERE ${inRange}
          GROUP BY t.id, t.name`,
        [from, to, scopeTeacherId ?? null],
      ),
    ]);
    return {
      subjects: subjects.map((r) => ({ key: String(r.key), name: String(r.name), lessons: Number(r.lessons) })),
      teachers: teachers
        .map((r) => ({ id: Number(r.id), name: String(r.name), lessons: Number(r.lessons) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id),
    };
  }

  async range({
    from,
    to,
    teacherId,
    subKey,
    scopeTeacherId,
  }: {
    from: string;
    to: string;
    teacherId?: number;
    subKey?: string;
    /** 강사 계정이면 본인 id — facet 도 이 범위 안에서만 센다. 매니저 이상은 없음 */
    scopeTeacherId?: number;
  }): Promise<BoardDto> {
    const rows = await this.q(
      `SELECT o.id AS occ_id, o.ser_id,
              to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS date,
              to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
              a.result AS attendance_result,
              ${hhmmOf('lower(o.span)')} AS start_at,
              ${hhmmOf('upper(o.span)')} AS end_at,
              -- 회차의 실제 방식 — 그 회차만 바꾼 예외(exc.mode)가 이긴다 (N-56 · lib/sql 한 조각) · 줌 마크가 이 값을 본다
              ${effectiveModeOf('ex', 's')} AS mode, s.kind_key, k.name AS kind_name, s.sub_key, sb.name AS sub_name,
              o.teacher_id, t.name AS teacher_name, rm.name AS room_name,
              o.zacc_id, z.label AS zacc_label,
              /* 그날 빠진 학생은 명단에서 뺀다 (D-R21).
                 스케줄 화면은 exc_stu_out 을 보고 droppedOnce 를 매기는데 여기만 안 보고 있었다 —
                 같은 날 같은 수업의 명단이 두 화면에서 달랐고, 빠진 학생의 교재까지 세고 있었다. */
              COALESCE((SELECT array_agg(st.name ORDER BY st.name)
                          FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                         WHERE ss.ser_id = o.ser_id
                           AND ${serStuOn('ss', 'o.on_date')}
                           AND NOT EXISTS (
                                 SELECT 1 FROM exc e
                                   JOIN exc_stu_out eo ON eo.exc_id = e.id
                                  WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date
                                    AND eo.student_id = ss.student_id)), '{}') AS student_names,
              /* 교재 — 이 수업 학생 중 배부받은 사람이 하나라도 있는가 */
              EXISTS (SELECT 1 FROM issue i
                       WHERE i.state = 'ok'
                         AND i.student_id IN (SELECT ss.student_id FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')})
                     ) AS book_done,
              /* 안내 — 대상(첫 수업·강사 교체)과 보낸 수는 guideNeeds() 가 §45 와 같은 식으로 센다 */
              /* 리포트 — 이 회차의 리포트가 적혔는가 (D-R7 은 「썼는가」 하나만 본다) */
              EXISTS (SELECT 1 FROM rep r
                       WHERE r.ser_id = o.ser_id AND r.on_date = o.on_date AND r.state = ANY($4)) AS report_done,
              /* 리포트 대상 수업인가 (D-R6) */
              k.rep AS kind_needs_report
         FROM ser_occ o
         JOIN ser  s  ON s.id = o.ser_id
         LEFT JOIN kind  k  ON k.key = s.kind_key
         LEFT JOIN staff t  ON t.id = o.teacher_id
         LEFT JOIN room  rm ON rm.id = o.room_id
         LEFT JOIN sub   sb ON sb.key = s.sub_key
         LEFT JOIN zacc  z  ON z.id = o.zacc_id
         LEFT JOIN att a ON a.ser_id = o.ser_id AND a.on_date = o.on_date
         LEFT JOIN exc ex ON ex.ser_id = o.ser_id AND ex.on_date = o.on_date
        WHERE ${kstDateOf('lower(o.span)')} BETWEEN $1::date AND $2::date
          AND ($3::bigint IS NULL OR o.teacher_id = $3)
          AND ($5::varchar IS NULL OR s.sub_key = $5)
        ORDER BY lower(o.span), o.id`,
      [from, to, teacherId ?? null, REPORT_WRITTEN_DB, subKey ?? null],
    );
    const [needs, facets] = await Promise.all([
      this.guideNeeds(rows.map((r) => Number(r.occ_id))),
      this.facets(from, to, scopeTeacherId),
    ]);

    const out = rows.map((r) => {
      const online = r.mode === 'online';
      const attendanceCanceled = r.attendance_result === 'canceled';
      const needsReport = r.kind_needs_report !== false && !attendanceCanceled;

      const guide = needs.get(Number(r.occ_id)) ?? { needed: 0, sent: 0 };
      const guideDone = guide.needed > 0 && guide.sent >= guide.needed;

      const marks: CheckMarkDto[] = [
        { key: 'book', done: r.book_done === true, na: false,
          note: r.book_done === true ? null: '배부된 교재가 없다' },
        { key: 'guide', done: guideDone, na: guide.needed === 0,
          note: guide.needed === 0 ? '첫 수업·강사 교체 학생이 없다'
            : guideDone ? null : `안내 대상 ${guide.needed}명 중 ${guide.needed - guide.sent}명 안 보냄` },
        { key: 'zoom', done: online ? r.zacc_id !== null && r.zacc_id !== undefined : false, na: !online,
          note: online ? (r.zacc_id ? null : '줌 계정이 안 붙었다') : '오프라인 수업' },
        { key: 'report', done: r.report_done === true, na: !needsReport,
          note: needsReport ? (r.report_done === true ? null : '리포트가 아직 없다') : '리포트 대상이 아닌 종류' },
      ];

      const missing = marks.filter((m) => !m.na && !m.done).length;

      return {
        occId: Number(r.occ_id), serId: Number(r.ser_id),
        date: String(r.date), onDate: String(r.on_date),
        startAt: String(r.start_at), endAt: String(r.end_at),
        teacherId: r.teacher_id === null || r.teacher_id === undefined ? null : Number(r.teacher_id),
        teacherName: (r.teacher_name as string) ?? null,
        roomName: (r.room_name as string) ?? null,
        zaccLabel: (r.zacc_label as string) ?? null,
        mode: String(r.mode), kindKey: String(r.kind_key),
        kindName: (r.kind_name as string) ?? null,
        subKey: (r.sub_key as string) ?? null,
        subName: (r.sub_name as string) ?? null,
        studentNames: (r.student_names as string[]) ?? [],
        canceled: r.canceled === true || attendanceCanceled,
        marks,
        missing,
      };
    });

    return {
      from, to,
      rows: out,
      missingCount: out.filter((r) => !r.canceled && r.missing > 0).length,
      ...boardSummary(out),
      facets,
      computedAt: new Date().toISOString(),
    };
  }
}
