/** @file-guide
 * 목적: ops.service.ts — OpsService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { daysUntil, overdueDays as daysSince, todayKst } from '../../lib/kst';
import { kstAt } from '../../lib/sql';
import {
  MFB_KIND_LABEL, mfbStateLabel, mktChannelLabel, mktItemLabel, mktTitle,
  type MfbKind,
} from '../../lib/marketing-words';
import {
  PLAN_DUE_STATE_LABEL, PLAN_OPEN_STAGES, PLAN_STAGES, PLAN_STAGE_LABEL, PLAN_STAGE_SUB,
} from '../../lib/plan-words';
import { CPL_STAGES, CPL_STAGE_LABEL, CPL_STAGE_SUB, cplAreaLabel } from '../../lib/complaint-words';
import { INTAKE_STAGES, INTAKE_STAGE_LABEL, INTAKE_STAGE_SUB, INTAKE_STOPS, INTAKE_STOP_LABEL, isIntakeFunnel } from '../../lib/intake-words';
import { INV_OPEN } from '../../lib/rules';
import { sqlWordList } from '../../lib/sql';
import {
  dueLabel, planDueKindLabel, planDueState, planStageLabel,
  type PlanDueState,
} from '../../lib/plan-words';
import {
  MINUTES_HINT, MINUTES_TEMPLATES, MT_ATTEND_LABEL, mtAttendState, mtTypeLabel,
} from '../../lib/meeting-words';
import type {
  IntakeAlertDto, IntakeHeadDto,
  LeadDto, MfbCommentWriteDto, MfbEditDto, MfbPostDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDueDecisionDto, PlanDueRowDto, PlanReviewDto, PlanTaskDto,
  MeetingDetailDto, MeetingTaskCreateDto, MeetingTaskDto, MinutesWriteDto,
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
              to_char(c.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name
         FROM cpl c
         LEFT JOIN stu s ON s.id = c.student_id
         LEFT JOIN staff o ON o.id = c.owner_id
        ORDER BY (c.stage = 'received') DESC, c.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), area: String(r.area), studentName: (r.student_name as string) ?? null,
      stage: String(r.stage), body: String(r.body),
      action: (r.action as string) ?? null, result: (r.result as string) ?? null,
      createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
      // 갈래 이름·담당은 **서버가 준다** — 화면이 제 표를 들면 §67 칩과 §69 줄이 갈린다 (D-R18)
      areaLabel: cplAreaLabel(String(r.area)),
      ownerName: (r.owner_name as string) ?? null,
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
      `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on,
              p.due_approved_at, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id ORDER BY p.due_on NULLS LAST, p.id`,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      const stage = String(r.stage);
      const open = PLAN_OPEN_STAGES.includes(stage);
      return {
        id: Number(r.id), title: String(r.title), stage,
        // 단계 이름을 만드는 자리는 서버 한 곳이다 — §61 보드 · §62 기한 표 · §65 보고서가 같이 쓴다 (D-R18)
        stageLabel: planStageLabel(stage),
        goal: (r.goal as string) ?? null, ask: (r.ask as string) ?? null,
        dueOn: due, ownerName: (r.owner_name as string) ?? null,
        overdueDays: open && due && due < today ? daysSince(due) : 0,
        dueState: planDueState(due, r.due_approved_at) as string,
      };
    });

    const { planDues, planOverdue } = await this.planDeadlines(today);

    const meetings = (await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date, m.minutes,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id)::int AS attendees,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed)::int AS confirmed
         FROM mtrec m ORDER BY m.on_date DESC NULLS LAST, m.id DESC`,
    )).map((r) => ({
      id: Number(r.id), mtType: String(r.mt_type),
      // 낱말은 서버가 만든다 — 한동안 이 표가 「general」 「plan」을 그대로 찍고 있었다 (D-R18 · C57)
      mtTypeLabel: mtTypeLabel(String(r.mt_type)),
      title: (r.title as string) ?? null,
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
      leads, complaints, todos, plans,
      // 칸 이름은 어휘라 데이터와 따로 간다 — 줄이 없는 칸도 이름을 갖는다 (D-R18)
      planStages: PLAN_STAGES.map((key) => ({ key, label: PLAN_STAGE_LABEL[key], sub: PLAN_STAGE_SUB[key] })),
      cplStages: CPL_STAGES.map((key) => ({ key, label: CPL_STAGE_LABEL[key], sub: CPL_STAGE_SUB[key] })),
      planDues, planOverdue, meetings, marketing,
      feedback, feedbackNeedsFix, canComment,
      suggestions, canSeeAmounts,
      intakeHead: await this.intakeHead(leads, canSeeAmounts),
    };
  }

  /* ══ §23 상담 머리 — 퍼널 · 담당 · 경고 (C86-a) ═══════════════════ */

  /**
   * 원본 §23 의 머리. **화면은 아무것도 세지 않는다** (D-R37 · N-19 의 교훈) —
   * 퍼널 여섯 칸, 등록률, 담당 칩, 경고 칩이 전부 여기서 나온다.
   *
   * 컷의 경고는 다섯인데 여기서 만드는 것은 **셋**이다. 나머지 둘(「상담 오늘·지남」·
   * 「사후 관리 밀림」)은 판정할 표가 아직 없다 — **없는 수를 지어내지 않는다** (N-44).
   */
  private async intakeHead(
    leads: ReadonlyArray<{ stage: string; ownerId?: number | null; ownerName?: string | null }>,
    canSeeAmounts: boolean,
  ): Promise<IntakeHeadDto> {
    const funnel = INTAKE_STAGES.map((key) => ({
      key,
      label: INTAKE_STAGE_LABEL[key],
      count: leads.filter((l) => l.stage === key).length,
      funnel: isIntakeFunnel(key),
      sub: INTAKE_STAGE_SUB[key],
    }));
    const total = leads.length;
    const enrolled = funnel.find((f) => f.key === 'enrolled')?.count ?? 0;

    // 담당 칩 — 한 번 훑어 담는다. 역할 비교가 아니라 사람 묶기라 Map 으로 센다
    const bucket = new Map<string, { id: number | null; name: string; count: number }>();
    for (const l of leads) {
      const id = l.ownerId ?? null;
      const key = id === null ? 'none' : String(id);
      const got = bucket.get(key);
      if (got) got.count += 1;
      else bucket.set(key, { id, name: l.ownerName ?? '담당 없음', count: 1 });
    }
    const owners = [...bucket.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));

    /*
     * 경고 셋 — 전부 **지금 남아 있는 것**을 센다(기준일이 필요 없다).
     * 셋을 따로 물으면 `/ops` 한 번에 왕복이 셋 는다. **한 문장으로 묶는다** —
     * 세 수는 서로 겹치지 않는 판정이라 UNION 으로 나란히 세면 된다.
     */
    const counts = await this.q(
      `SELECT 'unpaid' AS key,
              count(DISTINCT i.student_id)::int AS n,
              COALESCE(sum(i.amount - i.paid_amount), 0)::bigint AS amount
         FROM inv i
        WHERE i.state IN (${sqlWordList(INV_OPEN)}) AND i.amount > i.paid_amount
       UNION ALL
       -- 등록했는데 시간표가 없다 — 학생이 어느 회차 명단에도 안 들어 있다
       SELECT 'noSchedule', count(*)::int, 0::bigint FROM lead l
        WHERE l.stage = 'enrolled' AND l.student_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.student_id = l.student_id)
       UNION ALL
       -- 등록했는데 청구서가 없다 — 초안도 없는 경우만 센다(초안이라도 있으면 시작은 한 것이다)
       SELECT 'noInvoice', count(*)::int, 0::bigint FROM lead l
        WHERE l.stage = 'enrolled' AND l.student_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM inv i WHERE i.student_id = l.student_id)`,
    );
    const at = (key: string) => counts.find((r) => String(r.key) === key);
    const unpaidCount = Number(at('unpaid')?.n ?? 0);
    const unpaidAmount = Number(at('unpaid')?.amount ?? 0);
    const noSchedule = Number(at('noSchedule')?.n ?? 0);
    const noInvoice = Number(at('noInvoice')?.n ?? 0);

    const alerts: IntakeAlertDto[] = [
      {
        key: 'unpaid',
        // 금액을 못 보는 사람에게는 사람 수만 말한다 — 문장을 화면이 만들지 않는다 (D-R18 · D-R39)
        label: canSeeAmounts ? `미수 ${unpaidCount}명 ₩${unpaidAmount.toLocaleString('ko-KR')}` : `미수 ${unpaidCount}명`,
        count: unpaidCount,
        amount: canSeeAmounts ? unpaidAmount : null,
        go: '/accounting',
      },
      {
        key: 'noSchedule',
        label: `스케줄 미생성 ${noSchedule}`,
        count: noSchedule,
        amount: null,
        go: '/schedule',
      },
      {
        key: 'noInvoice',
        label: `등록했는데 청구서 없음 ${noInvoice}`,
        count: noInvoice,
        amount: null,
        go: '/accounting',
      },
    ];

    return {
      funnel,
      enrollRate: total === 0 ? 0 : Math.round((enrolled / total) * 100),
      owners,
      alerts,
      // 낱말과 순서만 — 세는 일은 §24 화면이 **검색으로 걸러진 행** 위에서 한다 (IntakeStopDto 주석)
      stops: INTAKE_STOPS.map((key) => ({ key, label: INTAKE_STOP_LABEL[key] })),
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
        `INSERT INTO noti (to_id, from_id, body, link, category)
         SELECT id, $1, $2, '/ops?mkt', 'request' FROM staff WHERE role <> 'teacher' AND id <> $1`,
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
          `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, '/ops?mkt', 'request')`,
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

  /* ══ §62 기획 기한 · §65 기획 보고서 (C56) ═══════════════════════════ */

  /**
   * 원문 §62 는 **기획 마감과 과제 기한을 한 표에** 날짜 순으로 섞는다.
   *
   * 두 표(PLAN · TODO)에서 오지만 화면은 한 줄씩만 본다 — 「남은 날」 낱말도 「기한 지난 것 N건」도
   * 서버가 만든다. 화면이 날짜를 빼기 시작하면 머리의 숫자와 줄의 색이 갈린다 (D-R37).
   */
  private async planDeadlines(today: string): Promise<{ planDues: PlanDueRowDto[]; planOverdue: number }> {
    const rows = await this.q(
      `SELECT 'plan' AS kind, p.id AS ref_id, p.id AS plan_id, p.title AS title, p.title AS plan_title,
              to_char(p.due_on,'YYYY-MM-DD') AS due_on, p.stage, o.name AS owner_name
         FROM plan p LEFT JOIN staff o ON o.id = p.owner_id
        WHERE p.due_on IS NOT NULL AND p.stage = ANY($1::text[])
       UNION ALL
       SELECT 'task', t.id, p.id, t.title, p.title,
              to_char(t.due_on,'YYYY-MM-DD'), p.stage, o.name
         FROM todo t
         JOIN plan p ON p.id = t.plan_id
         LEFT JOIN staff o ON o.id = t.to_id
        WHERE t.due_on IS NOT NULL AND NOT t.done
        ORDER BY 6, 2`,
      [[...PLAN_OPEN_STAGES]],
    );

    const planDues: PlanDueRowDto[] = rows.map((r) => {
      const due = String(r.due_on);
      const left = daysUntil(due, today);
      const kind = String(r.kind);
      const stage = String(r.stage);
      return {
        key: `${kind}:${String(r.ref_id)}`,
        kind, kindLabel: planDueKindLabel(kind),
        dueOn: due,
        // 「D-2 · 오늘 · 1일 지남」 — 낱말은 lib/plan-words 한 곳에서 나온다
        dueLabel: dueLabel(left),
        overdueDays: Math.max(0, -left),
        title: String(r.title), planId: leadId(r.plan_id), planTitle: String(r.plan_title),
        ownerName: (r.owner_name as string) ?? null,
        stage, stageLabel: planStageLabel(stage),
      };
    });
    return { planDues, planOverdue: planDues.filter((d) => d.overdueDays > 0).length };
  }

  /** §65 기획 보고서 — 목표 → 과제 → 리서치 → 결정 요청 */
  async planDetail(id: number, canApprove: boolean): Promise<PlanDetailDto | null> {
    const today = todayKst();
    const [p] = await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.research, p.ask,
              to_char(p.due_on,'YYYY-MM-DD') AS due_on, p.due_approved_at,
              to_char(p.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS created_on,
              o.name AS owner_name, a.name AS due_by_name
         FROM plan p
         LEFT JOIN staff o ON o.id = p.owner_id
         LEFT JOIN staff a ON a.id = p.due_approved_by
        WHERE p.id = $1`,
      [id],
    );
    if (!p) return null;

    const tasks = (await this.q(
      `SELECT t.id, t.title, t.done, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id
        WHERE t.plan_id = $1 ORDER BY t.due_on NULLS LAST, t.id`,
      [id],
    )).map((t): PlanTaskDto => {
      const due = (t.due_on as string) ?? null;
      const done = t.done === true;
      return {
        id: leadId(t.id), title: String(t.title), done,
        toName: (t.to_name as string) ?? null, dueOn: due,
        overdueDays: !done && due && due < today ? daysSince(due) : 0,
      };
    });

    const due = (p.due_on as string) ?? null;
    const dueState = planDueState(due, p.due_approved_at);
    const stage = String(p.stage);
    const open = PLAN_OPEN_STAGES.includes(stage);

    /* 원문 §61·§65: 「대표는 **기한을 먼저 승인해야** 최종 승인이 열립니다」.
       판정은 여기 한 곳이고, 막힌 이유까지 서버가 문장으로 내려보낸다 — 화면이 역할과
       기한 상태를 다시 조합하면 단추 모양과 서버의 답이 갈린다 (D-R39). */
    const canDecideDue = canApprove && dueState === 'proposed';
    const reviewBlockedReason =
      !canApprove ? '기획 결재는 대표만 합니다'
        : !open ? '이미 끝난 기획입니다'
          : dueState !== 'approved' ? '기한부터 승인하세요'
            : null;

    return {
      id: leadId(p.id), title: String(p.title), stage, stageLabel: planStageLabel(stage),
      ownerName: (p.owner_name as string) ?? null, createdOn: String(p.created_on),
      goal: (p.goal as string) ?? null,
      tasks, taskDone: tasks.filter((t) => t.done).length,
      research: (p.research as string) ?? null, ask: (p.ask as string) ?? null,
      dueOn: due, dueState, dueStateLabel: PLAN_DUE_STATE_LABEL[dueState as PlanDueState],
      dueApprovedByName: (p.due_by_name as string) ?? null,
      overdueDays: open && due && due < today ? daysSince(due) : 0,
      canDecideDue, canReview: reviewBlockedReason === null, reviewBlockedReason,
    };
  }

  /**
   * 기한 승인 · 반려 — 원문 §65 의 띠 안 단추 둘.
   *
   * 반려는 **기한을 지운다.** 담당자가 새 날짜를 다시 내야 하기 때문이다 — 승인 안 된 날짜를
   * 그대로 두면 §62 기한 표에 「대표를 지나오지 않은 마감」이 섞인다.
   */
  async decidePlanDue(viewerId: number, canApprove: boolean, id: number, dto: PlanDueDecisionDto): Promise<PlanDetailDto> {
    if (!canApprove) {
      throw new ConflictException({ code: 'CEO_ONLY', message: '기한 승인은 대표만 합니다 (원문 §61·§65)' });
    }
    const [row] = await this.q(
      `SELECT id, due_on, due_approved_at FROM plan WHERE id = $1`, [id],
    );
    if (!row) throw new NotFoundException('기획이 없습니다');
    if (!row.due_on) {
      throw new ConflictException({ code: 'NO_DUE', message: '제안된 기한이 없습니다' });
    }
    if (row.due_approved_at) {
      throw new ConflictException({ code: 'DUE_ALREADY_APPROVED', message: '이미 승인된 기한입니다' });
    }

    if (dto.approve) {
      await this.q(`UPDATE plan SET due_approved_at = now(), due_approved_by = $2 WHERE id = $1`, [id, viewerId]);
    } else {
      await this.q(`UPDATE plan SET due_on = NULL, due_approved_at = NULL, due_approved_by = NULL WHERE id = $1`, [id]);
    }
    return (await this.planDetail(id, canApprove))!;
  }

  /** 최종 승인 · 보완 요청 — **기한이 먼저 승인돼야 열린다** (원문 §61·§65) */
  async reviewPlan(viewerId: number, canApprove: boolean, id: number, dto: PlanReviewDto): Promise<PlanDetailDto> {
    const before = await this.planDetail(id, canApprove);
    if (!before) throw new NotFoundException('기획이 없습니다');
    if (!before.canReview) {
      throw new ConflictException({
        code: before.dueState === 'approved' ? 'NOT_REVIEWABLE' : 'DUE_NOT_APPROVED',
        message: before.reviewBlockedReason ?? '지금은 결재할 수 없습니다',
      });
    }
    if (dto.decision === 'rework' && !dto.reason?.trim()) {
      throw new ConflictException({ code: 'REASON_REQUIRED', message: '보완 요청에는 사유가 필요합니다' });
    }

    const next = dto.decision === 'approve' ? 'approved' : 'rework';
    await this.lead.manager.transaction(async (em) => {
      await em.query(`UPDATE plan SET stage = $2 WHERE id = $1`, [id, next]);
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'plan', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, id, dto.decision,
          JSON.stringify({ stage: before.stage }),
          JSON.stringify({ stage: next, reason: dto.reason?.trim() ?? null })],
      );
    });
    return (await this.planDetail(id, canApprove))!;
  }

  /* ══ §66 회의 상세 (C57) ═══════════════════════════════════════════════ */

  /**
   * 참석 확인 → 사전 자료 → 속기록 → 할 일.
   *
   * 참석은 **세 값**이다 — 아직 답 안 함(`null`) · 참석 · 불참. `null` 을 `false` 로 접으면
   * 「불참하겠다고 답한 사람」과 「아직 안 본 사람」이 같은 칩을 단다.
   */
  async meetingDetail(id: number): Promise<MeetingDetailDto | null> {
    const today = todayKst();
    const [m] = await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date,
              m.pre_files, m.minutes, ${kstAt('m.minutes_at')} AS minutes_at, b.name AS minutes_by_name
         FROM mtrec m LEFT JOIN staff b ON b.id = m.minutes_by
        WHERE m.id = $1`,
      [id],
    );
    if (!m) return null;

    const attendees = (await this.q(
      `SELECT a.staff_id, a.confirmed, s.name, s.title
         FROM mtattd a JOIN staff s ON s.id = a.staff_id
        WHERE a.mt_id = $1 ORDER BY s.id`,
      [id],
    )).map((r) => {
      const state = mtAttendState(r.confirmed as boolean | null);
      return {
        staffId: leadId(r.staff_id), name: String(r.name), title: (r.title as string) ?? null,
        state, stateLabel: MT_ATTEND_LABEL[state],
      };
    });

    const tasks = (await this.q(
      `SELECT t.id, t.title, t.done, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id
        WHERE t.mt_id = $1 ORDER BY t.due_on NULLS LAST, t.id`,
      [id],
    )).map((t): MeetingTaskDto => {
      const due = (t.due_on as string) ?? null;
      const done = t.done === true;
      return {
        id: leadId(t.id), title: String(t.title), done,
        toName: (t.to_name as string) ?? null, dueOn: due,
        overdueDays: !done && due && due < today ? daysSince(due) : 0,
      };
    });

    const confirmed = attendees.filter((a) => a.state === 'in').length;
    const files = Array.isArray(m.pre_files) ? (m.pre_files as unknown[]).map((f) => String(f)) : [];
    const mt = String(m.mt_type);

    return {
      id: leadId(m.id), mtType: mt, mtTypeLabel: mtTypeLabel(mt),
      title: (m.title as string) ?? null, onDate: (m.on_date as string) ?? null,
      attendees, confirmed,
      // 원문 「참석 0/4 확인」 — 화면이 다시 세지 않는다 (D-R37)
      attendLabel: `참석 ${confirmed}/${attendees.length} 확인`,
      preFiles: files,
      minutes: (m.minutes as string) ?? null,
      minutesAt: (m.minutes_at as string) ?? null,
      minutesByName: (m.minutes_by_name as string) ?? null,
      minutesTemplates: [...MINUTES_TEMPLATES],
      minutesHint: MINUTES_HINT,
      tasks, taskDone: tasks.filter((t) => t.done).length,
    };
  }

  /**
   * 속기록 저장 — **누가 언제**를 서버가 남긴다.
   *
   * 화면이 보낸 시각을 믿지 않는다. 시계가 틀린 기계에서 저장하면 회의록의 순서가 뒤집힌다.
   */
  async writeMinutes(viewerId: number, id: number, dto: MinutesWriteDto): Promise<MeetingDetailDto> {
    const [row] = await this.q(`SELECT id FROM mtrec WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('회의가 없습니다');
    await this.q(
      `UPDATE mtrec SET minutes = $2, minutes_at = now(), minutes_by = $3 WHERE id = $1`,
      [id, dto.minutes.trim(), viewerId],
    );
    return (await this.meetingDetail(id))!;
  }

  /**
   * 할 일 배정 — 원문 §66 「연동 **배정한 할 일 → TODO + 담당자 NOTI**」.
   *
   * 둘을 **한 트랜잭션**에서 한다. 밖에서 알림을 보내면 할 일은 안 만들어졌는데 알림만 가서
   * 받은 사람이 자기 목록에서 그것을 찾지 못한다 (D-R43).
   */
  async assignMeetingTask(viewerId: number, id: number, dto: MeetingTaskCreateDto): Promise<MeetingDetailDto> {
    const [m] = await this.q(`SELECT id, title, mt_type FROM mtrec WHERE id = $1`, [id]);
    if (!m) throw new NotFoundException('회의가 없습니다');
    const [to] = await this.q(`SELECT id, name FROM staff WHERE id = $1`, [dto.toId]);
    if (!to) throw new NotFoundException('담당자가 없습니다');

    const name = (m.title as string) ?? mtTypeLabel(String(m.mt_type));
    await this.lead.manager.transaction(async (em) => {
      await em.query(
        `INSERT INTO todo (title, from_id, to_id, due_on, done, src, mt_id)
         VALUES ($1, $2, $3, $4, false, 'meeting', $5)`,
        [dto.title.trim(), viewerId, dto.toId, dto.dueOn ?? null, id],
      );
      if (leadId(to.id) !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, '/ops?todo', 'request')`,
          [dto.toId, viewerId, `회의 할 일 — ${name}`],
        );
      }
    });
    return (await this.meetingDetail(id))!;
  }
}
