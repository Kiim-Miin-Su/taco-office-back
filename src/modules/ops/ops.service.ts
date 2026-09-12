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
import { kstAt } from '../../lib/sql';
import {
  MFB_KIND_LABEL, mfbStateLabel, mktChannelLabel, mktItemLabel, mktTitle,
  type MfbKind,
} from '../../lib/marketing-words';
import type {
  LeadDto, MfbCommentWriteDto, MfbEditDto, MfbPostDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
} from './ops.dto';

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

  async all(viewerId: number, canSeeAmounts: boolean, canComment: boolean): Promise<OpsDto> {
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
      `SELECT m.id, m.channel, m.item, m.url, m.result, m.title, m.by_id, b.name AS by_name
         FROM mkt m LEFT JOIN staff b ON b.id = m.by_id
        ORDER BY (m.result->>'enrolled')::int DESC NULLS LAST, m.id`,
    )).map((r) => {
      const res = (r.result ?? {}) as Record<string, number>;
      const enrolled = res.enrolled ?? 0;
      const cost = res.cost ?? 0;
      const channel = String(r.channel);
      const item = String(r.item);
      const title = (r.title as string) ?? null;
      return {
        id: Number(r.id), channel, item, url: (r.url as string) ?? null,
        // 낱말은 여기서 한 번만 만든다 — 화면이 코드를 한글로 옮기지 않는다 (D-R18 · C53)
        channelLabel: mktChannelLabel(channel), itemLabel: mktItemLabel(item),
        title, name: mktTitle(title, channel, item),
        byId: leadId(r.by_id, true), byName: (r.by_name as string) ?? null,
        impressions: res.impressions ?? null, clicks: res.clicks ?? null,
        inquiries: res.inquiries ?? null, enrolled,
        // 비용은 대표만 (D-R39) — 서버가 안 내려보낸다
        cost: canSeeAmounts ? cost : null,
        costPerEnroll: canSeeAmounts && enrolled > 0 ? Math.round(cost / enrolled) : null,
      };
    });

    const feedback = await this.feedbackThreads(viewerId);
    const feedbackNeedsFix = feedback.filter((t) => t.state === 'needs_fix').length;

    const suggestions = (await this.q(
      `SELECT g.id, s.name AS staff_name, g.category, g.body, g.state, g.reply,
              to_char(g.created_at,'YYYY-MM-DD') AS created_at
         FROM suggestion g JOIN staff s ON s.id = g.staff_id ORDER BY g.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), staffName: String(r.staff_name), category: String(r.category),
      body: String(r.body), state: String(r.state), reply: (r.reply as string) ?? null,
      createdAt: String(r.created_at),
    }));

    return {
      leads, complaints, todos, plans, meetings, marketing,
      feedback, feedbackNeedsFix, canComment,
      suggestions, canSeeAmounts,
    };
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

  /* ══ §60 대표 피드백 — 코멘트 · 답변 · 판정 (C53) ══════════════════════ */

  /**
   * 한 활동에 달린 글을 시각 순으로 모아 카드 한 장을 만든다.
   *
   * `mkt_id` 가 비어 있는 MFB 행은 **카드가 없다** — 원문 §60 은 카드마다 마케팅 활동
   * 하나를 머리에 달고 있어서 붙을 곳이 없다. 그래서 안쪽 join 이다.
   */
  private async feedbackThreads(viewerId: number): Promise<MfbThreadDto[]> {
    const rows = await this.q(
      `SELECT f.id, f.mkt_id, f.kind, f.parent_id, f.body, f.by_id, ${kstAt('f.at')} AS at,
              s.name AS by_name,
              m.channel, m.item, m.title, m.url, m.by_id AS owner_id, o.name AS owner_name
         FROM mfb f
         JOIN mkt m ON m.id = f.mkt_id
         LEFT JOIN staff s ON s.id = f.by_id
         LEFT JOIN staff o ON o.id = m.by_id
        ORDER BY f.mkt_id, f.at, f.id`,
    );

    const byMkt = new Map<number, MfbThreadDto>();
    const lastComment = new Map<number, MfbPostDto>();
    const answered = new Map<number, Set<number>>();

    for (const r of rows) {
      const mktId = leadId(r.mkt_id);
      let t = byMkt.get(mktId);
      if (!t) {
        const channel = String(r.channel);
        const item = String(r.item);
        const ownerId = leadId(r.owner_id, true);
        t = {
          mktId,
          name: mktTitle((r.title as string) ?? null, channel, item),
          channelLabel: mktChannelLabel(channel),
          itemLabel: mktItemLabel(item),
          url: (r.url as string) ?? null,
          byName: (r.owner_name as string) ?? null,
          state: 'needs_fix', stateLabel: '', at: String(r.at),
          posts: [],
          // 담당자가 정해져 있으면 그 사람이 답한다. 아직 아무도 아니면 이 화면을 보는 관리자가 답한다.
          canReply: ownerId === null || ownerId === viewerId,
        };
        byMkt.set(mktId, t);
        answered.set(mktId, new Set());
      }
      const kind = String(r.kind) as MfbKind;
      const post: MfbPostDto = {
        id: leadId(r.id), kind,
        kindLabel: MFB_KIND_LABEL[kind] ?? kind,
        body: String(r.body), byId: leadId(r.by_id),
        byName: (r.by_name as string) ?? null, at: String(r.at),
      };
      t.posts.push(post);
      if (kind === 'comment') lastComment.set(mktId, post);
      else if (r.parent_id != null) answered.get(mktId)?.add(leadId(r.parent_id));
    }

    // 「고쳤습니다 / 확인 필요」는 **가장 나중 코멘트에 답이 달렸는가** 하나로 정한다.
    // 시각 비교로 만들면 칩과 머리의 숫자가 갈린다 (D-R39).
    const threads = [...byMkt.values()];
    for (const t of threads) {
      const last = lastComment.get(t.mktId);
      const done = last ? (answered.get(t.mktId)?.has(last.id) ?? false) : true;
      t.state = done ? 'fixed' : 'needs_fix';
      t.stateLabel = mfbStateLabel(t.state);
      if (last) t.at = last.at;
    }
    // 고쳐야 할 것이 위로. 같은 상태면 최근 코멘트가 위로.
    threads.sort((a, b) =>
      a.state === b.state ? b.at.localeCompare(a.at) : a.state === 'needs_fix' ? -1 : 1);
    return threads;
  }

  /**
   * 대표 코멘트 — 원문 §60 「대표가 코멘트를 남기면 **관리자 전원**에게 알림이 갑니다」.
   * 알림 대상은 규칙 그대로 관리자 전원이며, 쓴 본인은 뺀다.
   */
  async comment(viewerId: number, canComment: boolean, mktId: number, dto: MfbCommentWriteDto): Promise<MfbThreadDto[]> {
    if (!canComment) {
      throw new ConflictException({ code: 'CEO_ONLY', message: '대표 코멘트는 대표만 남깁니다 (원문 §60)' });
    }
    const [mkt] = await this.q(`SELECT id, channel, item, title FROM mkt WHERE id = $1`, [mktId]);
    if (!mkt) throw new NotFoundException('마케팅 활동이 없습니다');
    const name = mktTitle((mkt.title as string) ?? null, String(mkt.channel), String(mkt.item));

    await this.lead.manager.transaction(async (em) => {
      await em.query(
        `INSERT INTO mfb (mkt_id, by_id, body, kind, parent_id) VALUES ($1, $2, $3, 'comment', NULL)`,
        [mktId, viewerId, dto.body.trim()],
      );
      await em.query(
        `INSERT INTO noti (to_id, from_id, body, link)
         SELECT id, $1, $2, '/ops?mkt' FROM staff WHERE role <> 'teacher' AND id <> $1`,
        [viewerId, `대표 피드백 — ${name}`],
      );
    });
    return this.feedbackThreads(viewerId);
  }

  /**
   * 담당자 답변 — 원문 §60 「담당자 답변은 **대표에게만**」.
   * 코멘트를 쓴 대표 한 사람에게만 간다. 전원 공지는 대표 코멘트 쪽 규칙이다.
   */
  async reply(viewerId: number, mktId: number, dto: MfbReplyWriteDto): Promise<MfbThreadDto[]> {
    const [parent] = await this.q(
      `SELECT f.id, f.by_id, f.kind, f.mkt_id, m.by_id AS owner_id, m.channel, m.item, m.title
         FROM mfb f JOIN mkt m ON m.id = f.mkt_id WHERE f.id = $1`,
      [dto.parentId],
    );
    if (!parent || leadId(parent.mkt_id) !== mktId) throw new NotFoundException('코멘트가 없습니다');
    if (String(parent.kind) !== 'comment') {
      throw new ConflictException({ code: 'NOT_A_COMMENT', message: '답변에는 답할 수 없습니다' });
    }
    const ownerId = leadId(parent.owner_id, true);
    if (ownerId !== null && ownerId !== viewerId) {
      throw new ConflictException({ code: 'NOT_OWNER', message: '이 활동의 담당자만 답할 수 있습니다' });
    }
    const name = mktTitle((parent.title as string) ?? null, String(parent.channel), String(parent.item));

    await this.lead.manager.transaction(async (em) => {
      await em.query(
        `INSERT INTO mfb (mkt_id, by_id, body, kind, parent_id) VALUES ($1, $2, $3, 'reply', $4)`,
        [mktId, viewerId, dto.body.trim(), dto.parentId],
      );
      const to = leadId(parent.by_id);
      if (to !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link) VALUES ($1, $2, $3, '/ops?mkt')`,
          [to, viewerId, `피드백 답변 — ${name}`],
        );
      }
    });
    return this.feedbackThreads(viewerId);
  }

  /** 답 고치기 — 원문 §60 「답 고치기」. **자기가 쓴 글만** 고친다 */
  async editPost(viewerId: number, postId: number, dto: MfbEditDto): Promise<MfbThreadDto[]> {
    const [row] = await this.q(`SELECT id, by_id FROM mfb WHERE id = $1`, [postId]);
    if (!row) throw new NotFoundException('글이 없습니다');
    if (leadId(row.by_id) !== viewerId) {
      throw new ConflictException({ code: 'NOT_AUTHOR', message: '자기가 쓴 글만 고칠 수 있습니다' });
    }
    await this.q(`UPDATE mfb SET body = $2 WHERE id = $1`, [postId, dto.body.trim()]);
    return this.feedbackThreads(viewerId);
  }
}
