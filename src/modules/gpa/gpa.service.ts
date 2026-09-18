/** @file-guide
 * 목적: gpa.service.ts — GpaService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GPA 관리 (v2 §4.5·§82 · N-13 채택 ①) — 4주 사이클 포인트제.
 * gpaByStudent() = 배정 − 사용(ok) − 대기(wait). 이월 없음 — 닫힌 사이클은 모든 쓰기 잠금.
 * 배정 초과는 막지 않는다(원문: 붉게 표시 + 추가 결제/다음 사이클 조정 안내) — over 로 내려 화면이 말한다.
 * points 는 기록 시점의 GPASVC.point 스냅샷 — 규정이 바뀌어도 과거 소비는 그대로다.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GpaCycle } from '../../entities';
import { addDays, todayKst } from '../../lib/kst';
import { kstAt, writtenRows } from '../../lib/sql';
import type {
  GpaAllocPutDto, GpaBoardDto, GpaCycleCloseResultDto, GpaCycleDto, GpaStudentDto, GpaStudentSvcDto, GpaUseCreateDto, GpaUseDto, GpaUseStateDto,
} from './gpa.dto';

type R = Record<string, unknown>;
const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;

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

  /**
   * 마감할 수 있는가 — **오늘** 기준이다(anchor 가 아니다). 열려 있고 · 끝날이 지났고 · 승인 대기가 0.
   * 끝나기 전에 닫으면 남은 날의 기록을 적을 사이클이 없어진다(기록 날짜는 사이클 창 안이어야 한다) — 그래서 끝날 전에는 막는다.
   */
  private closeIssue(cy: R, today: string): string | null {
    if (cy.closed === true) return '이미 마감된 사이클입니다';
    if (String(cy.t) >= today) return `사이클 끝(${md(String(cy.t))})이 지나야 마감할 수 있습니다 — 그 전에는 남은 날의 기록을 적을 자리가 없어집니다`;
    const wait = Number(cy.wait_count ?? 0);
    if (wait > 0) return `승인 대기 ${wait}건을 먼저 승인하거나 지워야 마감할 수 있습니다`;
    return null;
  }

  private cycleDto(cy: R, today: string): GpaCycleDto {
    const issue = this.closeIssue(cy, today);
    return {
      id: Number(cy.id), no: Number(cy.no), from: String(cy.f), to: String(cy.t), closed: cy.closed === true,
      closedAt: (cy.closed_at as string | null) ?? null, closedByName: (cy.closed_by_name as string | null) ?? null,
      canClose: issue === null, closeBlockedReason: issue,
    };
  }

  async board(anchor?: string): Promise<GpaBoardDto> {
    const services = (await this.q(
      `SELECT key, name, point FROM gpasvc ORDER BY sort NULLS LAST, key`,
    )).map((r) => ({ key: String(r.key), name: String(r.name), point: Number(r.point) }));

    const at = anchor ?? todayKst();
    const cy = await this.cycleAt(at);
    if (!cy) {
      return { cycle: null, hasPrev: false, hasNext: false, services, totalAlloc: 0, totalUsed: 0, totalWait: 0, totalRemain: 0, totalUses: 0, students: [], uses: [] };
    }
    const cycleId = Number(cy.id);
    const [nav] = await this.q(
      `SELECT EXISTS (SELECT 1 FROM gpa_cycle WHERE to_date < $1) AS has_prev,
              EXISTS (SELECT 1 FROM gpa_cycle WHERE from_date > $2) AS has_next`,
      [cy.f, cy.t]);

    const uses = await this.q(
      `SELECT u.id, u.student_id, u.svc_key, u.points, u.on_date::text AS on_date,
              u.start_min, u.ser_id, u.note_url, u.state, co.name AS coord_name
         FROM gpa_use u LEFT JOIN staff co ON co.id = u.coord_id
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
      `SELECT st.id, st.name, st.grade, co.name AS coord_name,
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
      cycle: this.cycleDto(cy, todayKst()),
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
    };
  }

  private useRow(r: R): GpaUseDto {
    return {
      id: Number(r.id), studentId: Number(r.student_id), svcKey: String(r.svc_key),
      points: Number(r.points), onDate: String(r.on_date),
      startMin: r.start_min === null || r.start_min === undefined ? null : Number(r.start_min),
      serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
      coordName: (r.coord_name as string) ?? null,
      noteUrl: (r.note_url as string) ?? null,
      state: String(r.state),
    };
  }

  /** 열린 사이클 행을 가져온다 — 닫힘/부재를 한 곳에서 판정 (이월 없음 · D-R29). */
  private async openCycle(cycleId: number): Promise<{ f: string; t: string }> {
    const [cy] = await this.q<{ f: string; t: string; closed: boolean }>(
      `SELECT from_date::text AS f, to_date::text AS t, closed FROM gpa_cycle WHERE id = $1`, [cycleId]);
    if (!cy) throw new NotFoundException('사이클을 찾을 수 없습니다');
    if (cy.closed) {
      throw new ConflictException({ code: 'CYCLE_CLOSED', message: '닫힌 사이클입니다 — 잔여는 소멸했고 기록·배정을 바꿀 수 없습니다' });
    }
    return cy;
  }

  /** 회차 소비 기록 — wait 로 들어간다. 포인트는 규정 스냅샷, 초과는 막지 않는다(화면이 붉게 안내). */
  async createUse(coordId: number, dto: GpaUseCreateDto): Promise<GpaUseDto> {
    const cy = await this.openCycle(dto.cycleId);
    if (dto.onDate < cy.f || dto.onDate > cy.t) {
      throw new ConflictException({ code: 'OUT_OF_CYCLE', message: '기록 날짜가 이 사이클 창 밖입니다' });
    }
    const [svc] = await this.q<{ point: number }>(`SELECT point FROM gpasvc WHERE key = $1`, [dto.svcKey]);
    if (!svc) throw new NotFoundException('서비스 규정을 찾을 수 없습니다');
    const [stu] = await this.q(`SELECT id FROM stu WHERE id = $1`, [dto.studentId]);
    if (!stu) throw new NotFoundException('학생을 찾을 수 없습니다');
    await this.q(
      `INSERT INTO gpa_use (cycle_id, student_id, ser_id, svc_key, points, on_date, start_min, coord_id, note_url, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'wait')`,
      [dto.cycleId, dto.studentId, dto.serId ?? null, dto.svcKey, Number(svc.point), dto.onDate,
       dto.startMin ?? null, coordId, dto.noteUrl?.trim() || null],
    );
    const [row] = await this.q(
      `SELECT u.id, u.student_id, u.svc_key, u.points, u.on_date::text AS on_date, u.start_min, u.ser_id,
              u.note_url, u.state, co.name AS coord_name
         FROM gpa_use u LEFT JOIN staff co ON co.id = u.coord_id
        WHERE u.cycle_id = $1 AND u.student_id = $2 ORDER BY u.id DESC LIMIT 1`,
      [dto.cycleId, dto.studentId]);
    return this.useRow(row);
  }

  /** 승인(ok)·되돌림(wait) — 닫힌 사이클은 잠긴다. */
  async setUseState(id: number, dto: GpaUseStateDto): Promise<GpaUseDto> {
    const [row] = await this.q(`SELECT cycle_id FROM gpa_use WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('기록을 찾을 수 없습니다');
    await this.openCycle(Number(row.cycle_id));
    await this.q(`UPDATE gpa_use SET state = $2 WHERE id = $1`, [id, dto.state]);
    const [out] = await this.q(
      `SELECT u.id, u.student_id, u.svc_key, u.points, u.on_date::text AS on_date, u.start_min, u.ser_id,
              u.note_url, u.state, co.name AS coord_name
         FROM gpa_use u LEFT JOIN staff co ON co.id = u.coord_id WHERE u.id = $1`, [id]);
    return this.useRow(out);
  }

  /** 잘못 기록한 wait 만 지운다 — 승인분은 불변, 닫힌 사이클은 잠긴다. */
  async deleteUse(id: number): Promise<{ ok: true }> {
    const [row] = await this.q<{ cycle_id: string; state: string }>(
      `SELECT cycle_id, state FROM gpa_use WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('기록을 찾을 수 없습니다');
    await this.openCycle(Number(row.cycle_id));
    if (row.state !== 'wait') {
      throw new ConflictException({ code: 'USE_APPROVED', message: '승인된 기록은 지울 수 없습니다 — 되돌림(wait) 후 처리하세요' });
    }
    await this.q(`DELETE FROM gpa_use WHERE id = $1 AND state = 'wait'`, [id]);
    return { ok: true };
  }

  /** 배정 upsert — (cycle, student) 하나. 0 은 배정 회수. 닫힌 사이클은 잠긴다. */
  async putAlloc(coordId: number, dto: GpaAllocPutDto): Promise<GpaStudentDto> {
    await this.openCycle(dto.cycleId);
    const [stu] = await this.q(`SELECT id, name, grade FROM stu WHERE id = $1`, [dto.studentId]);
    if (!stu) throw new NotFoundException('학생을 찾을 수 없습니다');
    await this.q(
      `INSERT INTO gpa_alloc (cycle_id, student_id, coord_id, points)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cycle_id, student_id) DO UPDATE SET points = EXCLUDED.points, coord_id = EXCLUDED.coord_id`,
      [dto.cycleId, dto.studentId, coordId, dto.points]);
    const [sums] = await this.q(
      `SELECT COALESCE(SUM(points) FILTER (WHERE state = 'ok'), 0) AS used,
              COALESCE(SUM(points) FILTER (WHERE state = 'wait'), 0) AS wait
         FROM gpa_use WHERE cycle_id = $1 AND student_id = $2`, [dto.cycleId, dto.studentId]);
    const [co] = await this.q<{ name: string }>(`SELECT name FROM staff WHERE id = $1`, [coordId]);
    const used = Number(sums?.used ?? 0); const wait = Number(sums?.wait ?? 0);
    const remain = dto.points - used - wait;
    return {
      studentId: Number(stu.id), name: String(stu.name), grade: (stu.grade as string) ?? null,
      coordName: co?.name ?? null, alloc: dto.points, used, wait, remain, over: remain < 0,
      // 배정 저장 응답은 **그 한 줄**이다 — 카드 칩은 보드 조회가 만든다
      svcs: [],
    };
  }

  /* ══ C95 · O-150 「4주마다 — GPA 사이클 마감」 ════════════════════════════════════════════════════
   * 도장(closed_at/by)을 찍고 잔여를 그대로 소멸 포인트로 돌려준다 — board() 와 같은 셈(배정 − 승인 사용)이다.
   * 다음 사이클이 없으면 끝날 다음 날부터 4주를 연다 — 4주마다 하는 일이 한 번에 끝나야 다음 기록이 막히지 않는다.
   * ══════════════════════════════════════════════════════════════════════════════════════ */
  async closeCycle(userId: number, cycleId: number): Promise<GpaCycleCloseResultDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const q = <T = R>(sql: string, p: unknown[] = []): Promise<T[]> => m.query(sql, p) as Promise<T[]>;
      await q(`SELECT id FROM gpa_cycle WHERE id = $1 FOR UPDATE`, [cycleId]);
      const [cy] = await q(`${GpaService.CYCLE_SELECT} WHERE c.id = $1`, [cycleId]);
      if (!cy) throw new NotFoundException('사이클을 찾을 수 없습니다');
      const today = todayKst();
      const issue = this.closeIssue(cy, today);
      if (issue) {
        throw new ConflictException({ code: cy.closed === true ? 'CYCLE_CLOSED' : Number(cy.wait_count ?? 0) > 0 ? 'CYCLE_HAS_WAIT' : 'CYCLE_NOT_ENDED', message: issue });
      }
      const students = await q(
        `SELECT st.id, st.name, COALESCE(a.points, 0) - COALESCE(u.used, 0) AS remain
           FROM (SELECT student_id FROM gpa_alloc WHERE cycle_id = $1
                 UNION SELECT student_id FROM gpa_use WHERE cycle_id = $1) x
           JOIN stu st ON st.id = x.student_id
           LEFT JOIN gpa_alloc a ON a.cycle_id = $1 AND a.student_id = st.id
           LEFT JOIN (SELECT student_id, SUM(points) FILTER (WHERE state = 'ok') AS used FROM gpa_use WHERE cycle_id = $1 GROUP BY student_id) u
                  ON u.student_id = st.id
          ORDER BY remain, st.name`, [cycleId]);
      const rows = students.map((r) => ({ studentId: Number(r.id), name: String(r.name), remain: Number(r.remain) }));
      const closedRows = writtenRows<R>(await q(
        `UPDATE gpa_cycle SET closed = true, closed_at = now(), closed_by = $2 WHERE id = $1 AND NOT closed RETURNING id`, [cycleId, userId],
      ));
      if (closedRows.length === 0) throw new ConflictException({ code: 'CYCLE_CLOSED', message: '이미 마감된 사이클입니다' });
      /* 다음 사이클 — 없을 때만. 끝날 다음 날부터 4주(28일) */
      let opened: GpaCycleDto | null = null;
      const [next] = await q(`SELECT id FROM gpa_cycle WHERE from_date > $1::date ORDER BY from_date LIMIT 1`, [cy.t]);
      if (!next) {
        const from = addDays(String(cy.t), 1);
        const [made] = await q<{ id: string }>(
          `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES ($1, $2::date, $3::date) RETURNING id`,
          [Number(cy.no) + 1, from, addDays(from, 27)]);
        const [row] = await q(`${GpaService.CYCLE_SELECT} WHERE c.id = $1`, [made.id]);
        opened = this.cycleDto(row, today);
      }
      await q(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'GPA_CYCLE',$2,'close',$3::jsonb,$4::jsonb)`,
        [userId, cycleId, JSON.stringify({ closed: false }), JSON.stringify({ closed: true, expired: rows.filter((r) => r.remain > 0).reduce((a, r) => a + r.remain, 0), openedCycleId: opened?.id ?? null })],
      );
      const [after] = await q(`${GpaService.CYCLE_SELECT} WHERE c.id = $1`, [cycleId]);
      return {
        cycle: this.cycleDto(after, today),
        opened,
        expiredPoints: rows.filter((r) => r.remain > 0).reduce((a, r) => a + r.remain, 0),
        students: rows,
      };
    });
  }
}
