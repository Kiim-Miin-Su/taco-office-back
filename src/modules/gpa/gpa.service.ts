/** @file-guide
 * 목적: gpa.service.ts — GpaService (service)
 * 책임/재사용: 조회 SQL과 확정 규칙 판정을 서버 한 곳에 둔다. 화면 재계산·규칙 복제를 만들지 않고 rules/kst 를 재사용한다.
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
import { todayKst } from '../../lib/kst';
import type {
  GpaAllocPutDto, GpaBoardDto, GpaStudentDto, GpaUseCreateDto, GpaUseDto, GpaUseStateDto,
} from './gpa.dto';

type R = Record<string, unknown>;

@Injectable()
export class GpaService {
  constructor(@InjectRepository(GpaCycle) private readonly anyRepo: Repository<GpaCycle>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** anchor 를 품는 사이클, 없으면 직전(과거) 사이클 — 미래 사이클을 임의로 만들지 않는다. */
  private async cycleAt(anchor: string): Promise<R | null> {
    const [hit] = await this.q(
      `SELECT id, no, from_date::text AS f, to_date::text AS t, closed
         FROM gpa_cycle WHERE from_date <= $1 AND to_date >= $1
        ORDER BY from_date DESC, id DESC LIMIT 1`, [anchor]);
    if (hit) return hit;
    const [prev] = await this.q(
      `SELECT id, no, from_date::text AS f, to_date::text AS t, closed
         FROM gpa_cycle WHERE to_date < $1 ORDER BY to_date DESC, id DESC LIMIT 1`, [anchor]);
    return prev ?? null;
  }

  async board(anchor?: string): Promise<GpaBoardDto> {
    const services = (await this.q(
      `SELECT key, name, point FROM gpasvc ORDER BY sort NULLS LAST, key`,
    )).map((r) => ({ key: String(r.key), name: String(r.name), point: Number(r.point) }));

    const at = anchor ?? todayKst();
    const cy = await this.cycleAt(at);
    if (!cy) {
      return { cycle: null, hasPrev: false, hasNext: false, services, totalAlloc: 0, totalUsed: 0, totalWait: 0, totalRemain: 0, students: [], uses: [] };
    }
    const cycleId = Number(cy.id);
    const [nav] = await this.q(
      `SELECT EXISTS (SELECT 1 FROM gpa_cycle WHERE to_date < $1) AS has_prev,
              EXISTS (SELECT 1 FROM gpa_cycle WHERE from_date > $2) AS has_next`,
      [cy.f, cy.t]);

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
      };
    });

    const uses = await this.q(
      `SELECT u.id, u.student_id, u.svc_key, u.points, u.on_date::text AS on_date,
              u.start_min, u.ser_id, u.note_url, u.state, co.name AS coord_name
         FROM gpa_use u LEFT JOIN staff co ON co.id = u.coord_id
        WHERE u.cycle_id = $1
        ORDER BY u.on_date, u.start_min NULLS LAST, u.id`, [cycleId]);

    return {
      cycle: { id: cycleId, no: Number(cy.no), from: String(cy.f), to: String(cy.t), closed: cy.closed === true },
      hasPrev: (nav?.has_prev as boolean) === true,
      hasNext: (nav?.has_next as boolean) === true,
      services,
      totalAlloc: rows.reduce((a, r) => a + r.alloc, 0),
      totalUsed: rows.reduce((a, r) => a + r.used, 0),
      totalWait: rows.reduce((a, r) => a + r.wait, 0),
      totalRemain: rows.reduce((a, r) => a + r.remain, 0),
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
    };
  }
}
