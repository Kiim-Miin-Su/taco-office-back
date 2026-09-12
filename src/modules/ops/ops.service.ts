/** @file-guide
 * 목적: ops.service.ts — OpsService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { overdueDays as daysSince, todayKst } from '../../lib/kst';
import type { LeadDto, OpsDto } from './ops.dto';

type R = Record<string, unknown>;

/** pg bigint의 숫자 문자열만 변환한다. 연결 없음과 ID 0/정밀도 손실은 구분한다. */
function leadId(value: unknown): number;
function leadId(value: unknown, nullable: true): number | null;
function leadId(value: unknown, nullable = false): number | null {
  if (nullable && value == null) return null;
  const id = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new InternalServerErrorException('상담 데이터 무결성 오류');
  return id;
}

@Injectable()
export class OpsService {
  constructor(@InjectRepository(Lead) private readonly lead: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.lead.query(sql, p) as Promise<T[]>;
  }

  async all(canSeeAmounts: boolean): Promise<OpsDto> {
    const today = todayKst();

    // N-25: failed 건의 되살릴 단계 판정을 응답에 미리 싣는다 — 명시값 → 도달 기록 역순 → 미분류(null).
    // leads 조회가 첫 query 인 기존 계약은 유지 — 로그 판정은 명시값 없는 failed 건이 있을 때만 한 번 뒤따른다.
    const pending = new Map<number, LeadDto>();
    const leads = (await this.q(
      `SELECT l.id, l.name, l.school, l.stage, l.stop_at, l.reason, l.owner_id, l.student_id, l.fail_from,
              to_char(l.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name
         FROM lead l LEFT JOIN staff o ON o.id = l.owner_id
        ORDER BY l.created_at DESC`,
    )).map((r): LeadDto => {
      const failFrom = (r.fail_from as string) ?? null;
      const failed = String(r.stage) === 'failed';
      const dto: LeadDto = {
        id: leadId(r.id), name: String(r.name), school: (r.school as string) ?? null,
        ownerId: leadId(r.owner_id, true), studentId: leadId(r.student_id, true),
        stage: String(r.stage), ownerName: (r.owner_name as string) ?? null,
        stopAt: (r.stop_at as string) ?? null, reason: (r.reason as string) ?? null,
        createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
        failFrom,
        revivalStage: failed ? failFrom : null,
        revivalSource: failed && failFrom ? 'explicit' : null,
      };
      if (failed && !failFrom) pending.set(dto.id, dto);
      return dto;
    });
    if (pending.size) {
      for (const g of await this.q(
        `SELECT DISTINCT ON (lead_id) lead_id, stage FROM lead_stage_log
          WHERE stage <> 'failed' AND lead_id = ANY($1)
          ORDER BY lead_id, id DESC`,
        [[...pending.keys()]],
      )) {
        const dto = pending.get(Number(g.lead_id));
        if (dto) { dto.revivalStage = String(g.stage); dto.revivalSource = 'log'; }
      }
    }

    const complaints = (await this.q(
      `SELECT c.id, c.area, s.name AS student_name, c.stage, c.body, c.action, c.result,
              to_char(c.created_at,'YYYY-MM-DD') AS created_at
         FROM cpl c LEFT JOIN stu s ON s.id = c.student_id
        ORDER BY (c.stage = 'received') DESC, c.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), area: String(r.area), studentName: (r.student_name as string) ?? null,
      stage: String(r.stage), body: String(r.body),
      action: (r.action as string) ?? null, result: (r.result as string) ?? null,
      createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
    }));

    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id
        ORDER BY t.done, t.due_on NULLS LAST, t.id`,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      return {
        id: Number(r.id), title: String(r.title), toName: (r.to_name as string) ?? null,
        dueOn: due, done: Boolean(r.done), src: String(r.src),
        overdueDays: !r.done && due && due < today ? daysSince(due) : 0,
      };
    });

    const plans = (await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id ORDER BY p.due_on NULLS LAST, p.id`,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      const open = r.stage !== 'done' && r.stage !== 'approved';
      return {
        id: Number(r.id), title: String(r.title), stage: String(r.stage),
        goal: (r.goal as string) ?? null, ask: (r.ask as string) ?? null,
        dueOn: due, ownerName: (r.owner_name as string) ?? null,
        overdueDays: open && due && due < today ? daysSince(due) : 0,
      };
    });

    const meetings = (await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date, m.minutes,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id)::int AS attendees,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed)::int AS confirmed
         FROM mtrec m ORDER BY m.on_date DESC NULLS LAST, m.id DESC`,
    )).map((r) => ({
      id: Number(r.id), mtType: String(r.mt_type), title: (r.title as string) ?? null,
      onDate: (r.on_date as string) ?? null,
      attendees: Number(r.attendees), confirmed: Number(r.confirmed),
      hasMinutes: Boolean(r.minutes),
    }));

    const marketing = (await this.q(
      `SELECT id, channel, item, url, result FROM mkt ORDER BY (result->>'enrolled')::int DESC NULLS LAST, id`,
    )).map((r) => {
      const res = (r.result ?? {}) as Record<string, number>;
      const enrolled = res.enrolled ?? 0;
      const cost = res.cost ?? 0;
      return {
        id: Number(r.id), channel: String(r.channel), item: String(r.item), url: (r.url as string) ?? null,
        impressions: res.impressions ?? null, clicks: res.clicks ?? null,
        inquiries: res.inquiries ?? null, enrolled,
        // 비용은 대표만 (D-R39) — 서버가 안 내려보낸다
        cost: canSeeAmounts ? cost : null,
        costPerEnroll: canSeeAmounts && enrolled > 0 ? Math.round(cost / enrolled) : null,
      };
    });

    const suggestions = (await this.q(
      `SELECT g.id, s.name AS staff_name, g.category, g.body, g.state, g.reply,
              to_char(g.created_at,'YYYY-MM-DD') AS created_at
         FROM suggestion g JOIN staff s ON s.id = g.staff_id ORDER BY g.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), staffName: String(r.staff_name), category: String(r.category),
      body: String(r.body), state: String(r.state), reply: (r.reply as string) ?? null,
      createdAt: String(r.created_at),
    }));

    return { leads, complaints, todos, plans, meetings, marketing, suggestions, canSeeAmounts };
  }

  /* ══ 상담 실패 이력 (v2 §24 · N-25 채택 §4-17 · C35) — 판정·기록은 서버 한 곳 ══ */

  /**
   * 실패 전이 — 이전 단계를 **그 순간의 사실**로 fail_from 에 명시 기록하고
   * 도달 기록(append-only)에 'failed' 를 남긴다. 등록 건은 실패로 보낼 수 없다.
   */
  async failLead(byId: number, id: number, dto: { stopAt: string; reason?: string }): Promise<LeadDto> {
    const [row] = await this.q(`SELECT id, stage FROM lead WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('상담 건을 찾을 수 없습니다');
    const stage = String(row.stage);
    if (stage === 'failed') throw new ConflictException({ code: 'ALREADY_FAILED', message: '이미 실패로 분류된 건입니다' });
    if (stage === 'enrolled') throw new ConflictException({ code: 'ENROLLED_LOCKED', message: '등록된 건은 실패로 보낼 수 없습니다' });
    await this.lead.manager.transaction(async (em) => {
      await em.query(
        `UPDATE lead SET stage = 'failed', fail_from = $2, stop_at = $3, reason = COALESCE($4, reason) WHERE id = $1`,
        [id, stage, dto.stopAt, dto.reason?.trim() || null]);
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'failed', $2)`, [id, byId]);
    });
    return this.leadOne(id);
  }

  /**
   * 되살리기 — 대상 단계는 지정값 → fail_from 명시값 → 도달 기록 역순. 셋 다 없으면
   * 미분류 그대로 두고 UNCLASSIFIED 로 거절한다 (추정 이관 금지 — 레거시 stop_at 을 쓰지 않는다).
   */
  async resumeLead(byId: number, id: number, dto: { to?: string }): Promise<LeadDto> {
    const [row] = await this.q(`SELECT id, stage, fail_from FROM lead WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('상담 건을 찾을 수 없습니다');
    if (String(row.stage) !== 'failed') {
      throw new ConflictException({ code: 'NOT_FAILED', message: '실패 상태의 건만 되살릴 수 있습니다' });
    }
    let target: string | null = dto.to ?? ((row.fail_from as string | null) ?? null);
    if (!target) {
      const [g] = await this.q(
        `SELECT stage FROM lead_stage_log WHERE lead_id = $1 AND stage <> 'failed' ORDER BY id DESC LIMIT 1`, [id]);
      target = g ? String(g.stage) : null;
    }
    if (!target) {
      throw new ConflictException({
        code: 'UNCLASSIFIED',
        message: '이력이 없어 되살릴 단계를 판정할 수 없습니다 — 단계를 지정해 주세요 (레거시 건은 추정하지 않습니다)',
      });
    }
    await this.lead.manager.transaction(async (em) => {
      await em.query(`UPDATE lead SET stage = $2, fail_from = NULL, stop_at = NULL WHERE id = $1`, [id, target]);
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, $2, $3)`, [id, target, byId]);
    });
    return this.leadOne(id);
  }

  private async leadOne(id: number): Promise<LeadDto> {
    const [r] = await this.q(
      `SELECT l.id, l.name, l.school, l.stage, l.stop_at, l.reason, l.owner_id, l.student_id, l.fail_from,
              to_char(l.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name
         FROM lead l LEFT JOIN staff o ON o.id = l.owner_id WHERE l.id = $1`, [id]);
    const failFrom = (r.fail_from as string) ?? null;
    const failed = String(r.stage) === 'failed';
    let logStage: string | null = null;
    if (failed && !failFrom) {
      const [g] = await this.q(
        `SELECT stage FROM lead_stage_log WHERE lead_id = $1 AND stage <> 'failed' ORDER BY id DESC LIMIT 1`, [id]);
      logStage = g ? String(g.stage) : null;
    }
    return {
      id: leadId(r.id), name: String(r.name), school: (r.school as string) ?? null,
      ownerId: leadId(r.owner_id, true), studentId: leadId(r.student_id, true),
      stage: String(r.stage), ownerName: (r.owner_name as string) ?? null,
      stopAt: (r.stop_at as string) ?? null, reason: (r.reason as string) ?? null,
      createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
      failFrom,
      revivalStage: failed ? (failFrom ?? logStage) : null,
      revivalSource: failed ? (failFrom ? 'explicit' : logStage ? 'log' : null) : null,
    };
  }
}
