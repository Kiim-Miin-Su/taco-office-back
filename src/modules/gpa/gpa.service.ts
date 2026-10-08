/** @file-guide
 * 목적: gpa.service.ts — GpaService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GPA 과거 원장 조회. 최신 수정사항에서 신규 GPA 기능과 모든 writer가 퇴역했다.
 * 과거 확정 행과 당시 스냅숏은 보존하고, 이 서비스는 관리자 읽기 전용 projection만 제공한다.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GpaCycle } from '../../entities';
import { todayKst } from '../../lib/kst';
import { END_MIN, kstAt } from '../../lib/sql';
import { studentLabel, studentTagSql } from '../../lib/student-label';
import type {
  GpaBoardDto, GpaCycleDto, GpaStudentDto, GpaStudentSvcDto, GpaUseDto,
} from './gpa.dto';

type R = Record<string, unknown>;
const GPA_RETIRED_REASON = 'GPA 신규 기능이 퇴역하여 과거 원장만 조회할 수 있습니다';

@Injectable()
export class GpaService {
  constructor(@InjectRepository(GpaCycle) private readonly anyRepo: Repository<GpaCycle>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** 사이클 한 줄 — 도장(누가·언제)과 승인 대기 수까지. board() 와 마감이 같은 모양을 읽는다 */
  private static readonly CYCLE_SELECT = `SELECT c.id, c.no, c.from_date::text AS f, c.to_date::text AS t, c.closed,
              ${kstAt('c.closed_at')} AS closed_at, cb.name AS closed_by_name,
              (SELECT count(*)::int FROM gpa_use u WHERE u.cycle_id = c.id AND u.state = 'wait') AS wait_count
         FROM gpa_cycle c LEFT JOIN staff cb ON cb.id = c.closed_by`;

  /**
   * 소비 기록 한 줄 — 보드 · 기록 응답 · 승인 응답이 **같은 모양**을 읽는다.
   *
   * 끝 시각(`end_min`)은 기록에 칸이 없다 — 연결된 회차(`ser_id`)가 그날 실제로 놓인 자리
   * (`ser_occ.span`)에서 읽는다(원본 §82 회차 내역 「18:00–18:45」 · 82-8). 회차가 없으면 null 이고
   * 화면은 시작만 적는다 — 없는 끝을 지어내지 않는다.
   */
  private static readonly USE_SELECT = `SELECT u.id, u.student_id, u.svc_key, u.points, u.on_date::text AS on_date,
              u.start_min, u.ser_id, u.note_url, u.state, u.coord_id, co.name AS coord_name, ap.name AS approved_by_name,
              to_char(u.approved_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS approved_on,
              (SELECT ${END_MIN} FROM ser_occ o WHERE o.ser_id = u.ser_id AND o.on_date = u.on_date LIMIT 1) AS end_min
         FROM gpa_use u LEFT JOIN staff co ON co.id = u.coord_id
         LEFT JOIN staff ap ON ap.id = u.approved_by`;

  /** anchor 를 품는 사이클, 없으면 직전(과거) 사이클 — 미래 사이클을 임의로 만들지 않는다. */
  private async cycleAt(anchor: string): Promise<R | null> {
    const [hit] = await this.q(
      `${GpaService.CYCLE_SELECT} WHERE c.from_date <= $1 AND c.to_date >= $1
        ORDER BY c.from_date DESC, c.id DESC LIMIT 1`, [anchor]);
    if (hit) return hit;
    const [prev] = await this.q(
      `${GpaService.CYCLE_SELECT} WHERE c.to_date < $1 ORDER BY c.to_date DESC, c.id DESC LIMIT 1`, [anchor]);
    return prev ?? null;
  }

  private cycleDto(cy: R): GpaCycleDto {
    return {
      id: Number(cy.id), no: Number(cy.no), from: String(cy.f), to: String(cy.t), closed: cy.closed === true,
      closedAt: (cy.closed_at as string | null) ?? null, closedByName: (cy.closed_by_name as string | null) ?? null,
      canClose: false, closeBlockedReason: GPA_RETIRED_REASON,
    };
  }

  async board(anchor?: string): Promise<GpaBoardDto> {
    const services = (await this.q(
      `SELECT key, name, point FROM gpasvc ORDER BY sort NULLS LAST, key`,
    )).map((r) => ({ key: String(r.key), name: String(r.name), point: Number(r.point) }));

    const at = anchor ?? todayKst();
    const cy = await this.cycleAt(at);
    if (!cy) {
      return { cycle: null, hasPrev: false, hasNext: false, services, totalAlloc: 0, totalUsed: 0, totalWait: 0, totalRemain: 0, totalUses: 0, students: [], uses: [], lessons: [] };
    }
    const cycleId = Number(cy.id);
    const [nav] = await this.q(
      `SELECT EXISTS (SELECT 1 FROM gpa_cycle WHERE to_date < $1) AS has_prev,
              EXISTS (SELECT 1 FROM gpa_cycle WHERE from_date > $2) AS has_next`,
      [cy.f, cy.t]);

    const uses = await this.q(
      `${GpaService.USE_SELECT}
        WHERE u.cycle_id = $1
        ORDER BY u.on_date, u.start_min NULLS LAST, u.id`, [cycleId]);

    /*
     * §82 카드의 서비스 칩 — **이미 읽어 온 소비 목록 한 벌**에서 접는다. 같은 것을 다시
     * 묻지 않는다. 승인 대기도 센다: 그 포인트는 잔여에서 이미 빠져 있어, 카드에서만 빼면
     * 「남은 9p」와 칩의 합이 갈린다 (N-19).
     */
    const svcOf = new Map<number, Map<string, { count: number; points: number }>>();
    for (const u of uses) {
      const sid = Number(u.student_id);
      const per = svcOf.get(sid) ?? new Map<string, { count: number; points: number }>();
      const got = per.get(String(u.svc_key)) ?? { count: 0, points: 0 };
      per.set(String(u.svc_key), { count: got.count + 1, points: got.points + Number(u.points) });
      svcOf.set(sid, per);
    }
    const svcsFor = (studentId: number): GpaStudentSvcDto[] =>
      services
        .filter((sv) => (svcOf.get(studentId)?.get(sv.key)?.count ?? 0) > 0)
        .map((sv) => ({
          key: sv.key, name: sv.name,
          count: svcOf.get(studentId)!.get(sv.key)!.count,
          points: svcOf.get(studentId)!.get(sv.key)!.points,
        }));

    // 배정 ∪ 소비 학생 — 배정 없이 소비만 있어도 보드에 보인다 (숨기면 초과를 못 본다)
    const students = await this.q(
      `SELECT st.id, st.name, st.grade, ${studentTagSql('st')} AS tag, co.name AS coord_name,
              COALESCE(a.points, 0) AS alloc,
              COALESCE(u.used, 0) AS used,
              COALESCE(u.wait, 0) AS wait
         FROM (SELECT student_id FROM gpa_alloc WHERE cycle_id = $1
               UNION SELECT student_id FROM gpa_use WHERE cycle_id = $1) x
         JOIN stu st ON st.id = x.student_id
         LEFT JOIN gpa_alloc a ON a.cycle_id = $1 AND a.student_id = st.id
         LEFT JOIN staff co ON co.id = a.coord_id
         LEFT JOIN (SELECT student_id,
                           SUM(points) FILTER (WHERE state = 'ok')   AS used,
                           SUM(points) FILTER (WHERE state = 'wait') AS wait
                      FROM gpa_use WHERE cycle_id = $1 GROUP BY student_id) u
                ON u.student_id = st.id
        ORDER BY st.name`, [cycleId]);
    const rows: GpaStudentDto[] = students.map((r) => {
      const alloc = Number(r.alloc); const used = Number(r.used); const wait = Number(r.wait);
      const remain = alloc - used - wait;
      return {
        studentId: Number(r.id), name: String(r.name), grade: (r.grade as string) ?? null,
        tag: (r.tag as string | null) ?? null, label: studentLabel(String(r.name), r.tag as string | null),
        coordName: (r.coord_name as string) ?? null,
        alloc, used, wait, remain, over: remain < 0,
        svcs: svcsFor(Number(r.id)),
      };
    });
    /*
     * 원본 §82 는 「5명 · 잔여 적은 순」이라 적는다 — **초과가 맨 앞**이다.
     * SQL 의 `ORDER BY st.name` 은 동점을 가르는 둘째 열로 남긴다(같은 잔여면 이름 순).
     */
    rows.sort((a, b) => a.remain - b.remain);


    return {
      cycle: this.cycleDto(cy),
      hasPrev: (nav?.has_prev as boolean) === true,
      hasNext: (nav?.has_next as boolean) === true,
      services,
      totalAlloc: rows.reduce((a, r) => a + r.alloc, 0),
      totalUsed: rows.reduce((a, r) => a + r.used, 0),
      totalWait: rows.reduce((a, r) => a + r.wait, 0),
      totalRemain: rows.reduce((a, r) => a + r.remain, 0),
      // 「N회 진행」 — 기록이 있다는 것은 회차가 있었다는 뜻이다 (승인 대기도 센다)
      totalUses: uses.length,
      students: rows,
      uses: uses.map((r) => this.useRow(r)),
      // BOC-13D 권고안: 응답 모양은 이전 클라이언트 호환을 위해 남기되 신규 입력 후보는 한 건도 제공하지 않는다.
      // 정책 변경 시 DTO/OpenAPI/Front/Figma/두 수정사항 대조표와 portfolio를 함께 갱신한다.
      lessons: [],
    };
  }

  /**
   * 과거 소비 기록 한 줄. 신규 승인/되돌림은 퇴역했으므로 capability는 항상 닫는다.
   */
  private useRow(r: R): GpaUseDto {
    return {
      id: Number(r.id), studentId: Number(r.student_id), svcKey: String(r.svc_key),
      points: Number(r.points), onDate: String(r.on_date),
      startMin: r.start_min === null || r.start_min === undefined ? null : Number(r.start_min),
      endMin: r.end_min === null || r.end_min === undefined ? null : Number(r.end_min),
      serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
      coordName: (r.coord_name as string) ?? null,
      noteUrl: (r.note_url as string) ?? null,
      state: String(r.state),
      // 승인 도장 — 목록 질의가 아직 안 읽는 자리에서는 undefined 가 아니라 null 로 내려간다
      approvedByName: (r.approved_by_name as string) ?? null,
      approvedOn: (r.approved_on as string) ?? null,
      canApprove: false,
    };
  }

}
