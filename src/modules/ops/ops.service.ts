/** @file-guide
 * 목적: ops.service.ts — OpsService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import { ZoomService } from '../zoom/zoom.service';
import { daysUntil, overdueDays as daysSince, todayKst } from '../../lib/kst';
import { kstAt } from '../../lib/sql';
import {
  MFB_KIND_LABEL, mfbStateLabel, mktChannelLabel, mktItemLabel, mktTitle,
  type MfbKind,
} from '../../lib/marketing-words';
import {
  PLAN_DUE_STATE_LABEL, PLAN_OPEN_STAGES, PLAN_STAGES, PLAN_STAGE_LABEL, PLAN_STAGE_SUB,
} from '../../lib/plan-words';
import { CPL_AREAS, CPL_AREA_LABEL, CPL_OPEN_STAGES, CPL_SEVERITIES, CPL_SEVERITY_LABEL, CPL_STAGES, CPL_STAGE_LABEL, CPL_STAGE_SUB, cplAreaLabel, cplSeverityLabel } from '../../lib/complaint-words';
import {
  INTAKE_FUNNEL_STAGES, INTAKE_STAGES, INTAKE_STAGE_LABEL, INTAKE_STAGE_SUB, INTAKE_STOPS, INTAKE_STOP_LABEL, isIntakeFunnel,
  LEAD_SOURCES, LEAD_SOURCE_LABEL, LEAD_SOURCE_TOUCH_KIND, LEAD_SOURCE_UNSET, LEAD_SOURCE_UNSET_LABEL,
  LEAD_TOUCH_KINDS, LEAD_TOUCH_KIND_LABEL, intakeStageLabel, leadNextStages, leadSourceLabel, leadTouchKindLabel,
  type LeadSource,
} from '../../lib/intake-words';
import { isSelfReview, SELF_APPROVAL_CODE } from '../../lib/approval';
import { INV_OPEN } from '../../lib/rules';
import { sqlWordList } from '../../lib/sql';
import {
  dueLabel, planDueKindLabel, planDueState, planStageLabel,
  type PlanDueState,
} from '../../lib/plan-words';
import {
  MINUTES_HINT, MINUTES_TEMPLATES, MT_ATTEND_LABEL, MT_TYPES, MT_TYPE_LABEL, MT_TYPE_SUB,
  mtAttendState, mtTypeLabel, mtTypeOptions, type MtType,
} from '../../lib/meeting-words';
import type {
  IntakeAlertDto, IntakeHeadDto,
  ComplaintCreateDto, ComplaintDto, ComplaintPatchDto,
  LeadCreateDto, LeadDto, LeadStageMoveDto, LeadTouchDto, LeadTouchWriteDto,
  MfbCommentWriteDto, MfbEditDto, MfbPostDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDueDecisionDto, PlanDueRowDto, PlanReviewDto, PlanTaskDto,
  MeetingDetailDto, MeetingTaskCreateDto, MeetingTaskDto, MinutesWriteDto,
  MeetingCreateDto, MeetingCreateResultDto, MeetingDto, OpsCountDto, OpsQueryDto,
  PlanCreateDto, PlanCreateResultDto,
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

/**
 * 지금 보고 있는 기간의 **낱말** — 화면이 「최근 두 달」 같은 말을 만들지 않는다 (D-R18 · C96).
 *
 * 컷 §63 의 머리가 「일간 주간 월간 **전체**」 옆에 「최근 두 달 54회」라 적는다. 그 문장은
 * 기간을 아는 쪽이 만들어야 한다 — 화면이 만들면 탭마다 다른 말이 된다.
 */
export function opsRangeLabel(from?: string | null, to?: string | null): string {
  if (!from && !to) return '전체';
  if (from && to && from === to) return from;
  if (from && to) {
    // 같은 달의 1일 ~ 말일이면 「2026년 9월」이라 부르는 편이 읽기 쉽다
    const [fy, fm, fd] = from.split('-');
    const [ty, tm] = to.split('-');
    const lastOfMonth = new Date(Date.UTC(Number(ty), Number(tm), 0)).getUTCDate();
    if (fy === ty && fm === tm && fd === '01' && to.endsWith(String(lastOfMonth).padStart(2, '0'))) {
      return `${fy}년 ${Number(fm)}월`;
    }
    return `${from} ~ ${to}`;
  }
  return from ? `${from} 부터` : `${to} 까지`;
}

/**
 * 기간으로 자르는 `WHERE` 한 조각.
 *
 * **날짜가 없는 줄은 가르지 않는다** — 기한 없는 할 일, 날짜 없는 옛 회의가 그렇다.
 * 없는 날짜를 「범위 밖」이라 하면 고른 달에서 그 줄이 조용히 사라진다. 모르는 것은 남긴다(N-25 의 결).
 */
function rangeClause(col: string, from: string | undefined, to: string | undefined, params: unknown[]): string {
  if (!from && !to) return '';
  const parts: string[] = [];
  if (from) { params.push(from); parts.push(`${col} >= $${params.length}::date`); }
  if (to) { params.push(to); parts.push(`${col} <= $${params.length}::date`); }
  return `(${col} IS NULL OR (${parts.join(' AND ')}))`;
}

@Injectable()
export class OpsService {
  constructor(
    @InjectRepository(Lead) private readonly lead: Repository<Lead>,
    /** 회의를 잡으면 **시간표에 회차가 생긴다** — 겹침·투영·불가 시간이 전부 거기 있다 (C96 · C95 와 같은 길) */
    private readonly schedule: ScheduleWriteService,
    /** 온라인 회의의 줌 배정도 **있는 길**을 탄다 — `assignIn` 이 다시 투영하고 EXCLUDE 가 겹침을 막는다 (C48) */
    private readonly zoom: ZoomService,
  ) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.lead.query(sql, p) as Promise<T[]>;
  }

  /**
   * @param query 기간·갈래 (C96 · N-46 ②). **검색 인자는 없다** — §24 FQ 는 받은 목록에서 거른다.
   *   목록마다 시간으로 삼는 날짜가 다르다: 상담·컴플레인은 **들어온 날**(`created_at`),
   *   회의는 **회의 날**(`on_date`), 할 일·기획은 **기한**(`due_on`). 날짜가 없는 줄은 가르지 않는다.
   */
  async all(viewerId: number, canSeeAmounts: boolean, canComment: boolean, query: OpsQueryDto = {}): Promise<OpsDto> {
    const today = todayKst();
    const { from, to, area } = query;
    if (from && to && to < from) {
      throw new ConflictException({ code: 'BAD_RANGE', message: '끝 날짜가 시작 날짜보다 앞설 수 없습니다' });
    }
    /** `WHERE` 하나를 만든다 — 갈래는 컴플레인에만 붙는다(§67 칩 줄이다) */
    const scoped = (col: string, extra?: { sql: string; value: unknown }) => {
      const params: unknown[] = [];
      const parts = [rangeClause(col, from, to, params)].filter(Boolean);
      if (extra) { params.push(extra.value); parts.push(extra.sql.replace('$?', `$${params.length}`)); }
      return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
    };

    // 한 줄의 모양은 leadRows 한 곳 — GET /ops 와 쓰기 응답이 같은 SELECT·같은 판정을 쓴다 (C90)
    const leadScope = scoped('l.created_at');
    const leads = await this.leadRows(leadScope.where, leadScope.params, today);

    const cplScope = scoped('c.created_at', area ? { sql: 'c.area = $?', value: area } : undefined);
    const complaints = await this.complaintRows(cplScope.where, cplScope.params, today, canSeeAmounts);
    // 칩 줄의 건수는 **갈래 필터를 빼고** 센다 — 「수업 1」을 고른 뒤에도 다른 갈래의 수가 보여야 고를 수 있다
    const cplCountScope = scoped('c.created_at');
    const areaCounts = await this.areaCounts(cplCountScope.where, cplCountScope.params);

    const todoScope = scoped('t.due_on');
    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id
        ${todoScope.where}
        ORDER BY t.done, t.due_on NULLS LAST, t.id`, todoScope.params,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      return {
        id: Number(r.id), title: String(r.title), toName: (r.to_name as string) ?? null,
        dueOn: due, done: Boolean(r.done), src: String(r.src),
        overdueDays: !r.done && due && due < today ? daysSince(due) : 0,
      };
    });

    const planScope = scoped('p.due_on');
    const plans = (await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on,
              p.due_approved_at, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id
        ${planScope.where}
        ORDER BY p.due_on NULLS LAST, p.id`, planScope.params,
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

    const mtScope = scoped('m.on_date');
    const meetings = await this.meetingRows(mtScope.where, mtScope.params);
    const mtCountScope = scoped('m.on_date');
    const mtTypeCounts = await this.mtTypeCounts(mtCountScope.where, mtCountScope.params);

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
      cplAreas: CPL_AREAS.map((key) => ({ key, label: CPL_AREA_LABEL[key] })),
      cplSeverities: CPL_SEVERITIES.map((key) => ({ key, label: CPL_SEVERITY_LABEL[key] })),
      planDues, planOverdue, meetings, marketing,
      feedback, feedbackNeedsFix, canComment,
      suggestions, canSeeAmounts,
      intakeHead: await this.intakeHead(leads, canSeeAmounts, today),
      range: { from: from ?? null, to: to ?? null, label: opsRangeLabel(from, to) },
      areaCounts, mtTypeCounts,
      // §64 담당 칩 줄 — 열린 할 일만 센다(끝난 것은 고를 일이 없다) · 담당 없는 것도 제 줄을 갖는다
      todoOwnerCounts: OpsService.ownerCounts(todos),
      mtTypes: mtTypeOptions().map((o) => ({ key: o.key, label: o.label })),
      // 단추가 서는지도 서버다 (D-R39) — 지금은 이 화면을 볼 수 있으면 만들 수 있다
      canCreateMeeting: true, canCreatePlan: true,
    };
  }

  /** 분을 「11:00」으로 — 알림 한 줄에만 쓴다 */
  private static hm(min: number): string {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }

  /** §64 담당 칩 — 「전체 3 · Hoon 1 · Lauren 1 · 김범준 1」 (D-R37 · 화면이 세지 않는다) */
  private static ownerCounts(todos: Array<{ toName: string | null; done: boolean }>): OpsCountDto[] {
    const open = todos.filter((t) => !t.done);
    const byName = new Map<string, number>();
    for (const t of open) {
      const key = t.toName ?? '';
      byName.set(key, (byName.get(key) ?? 0) + 1);
    }
    return [...byName.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key: key || '__none__', label: key || '담당 없음', count }));
  }

  /** §67 갈래 칩 — **0건 갈래도 선다**(어휘이지 데이터가 아니다 · C66) */
  private async areaCounts(where: string, params: unknown[]): Promise<OpsCountDto[]> {
    const rows = await this.q<{ area: string; n: string }>(
      `SELECT c.area, count(*)::text AS n FROM cpl c ${where} GROUP BY c.area`, params,
    );
    const got = new Map(rows.map((r) => [String(r.area), Number(r.n)]));
    return CPL_AREAS.map((key) => ({ key, label: CPL_AREA_LABEL[key], count: got.get(key) ?? 0 }));
  }

  /** §63 회의 종류 칩 — 같은 규약으로 0건도 선다 */
  private async mtTypeCounts(where: string, params: unknown[]): Promise<OpsCountDto[]> {
    const rows = await this.q<{ mt_type: string; n: string }>(
      `SELECT m.mt_type, count(*)::text AS n FROM mtrec m ${where} GROUP BY m.mt_type`, params,
    );
    const got = new Map(rows.map((r) => [String(r.mt_type), Number(r.n)]));
    return MT_TYPES.map((key) => ({ key, label: MT_TYPE_LABEL[key], count: got.get(key) ?? 0 }));
  }

  /**
   * §63 회의 한 줄 — 목록과 쓰기 응답이 **같은 SELECT** 를 쓴다 (C90 `leadRows` 와 같은 규약).
   *
   * 시각·자리는 `mtrec` 이 아니라 **이어진 회차**에서 읽는다 — 옛 회의는 이어진 것이 없어 셋 다 null 이고,
   * 화면은 그 사실을 그대로 말한다(지어내지 않는다 · N-25).
   */
  private async meetingRows(where: string, params: unknown[]): Promise<MeetingDto[]> {
    return (await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date, m.minutes, m.ser_id,
              s.start_min, s.end_min, s.mode, r.name AS room_name, z.label AS zoom_label,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id)::int AS attendees,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed)::int AS confirmed,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed IS NULL)::int AS waiting
         FROM mtrec m
         LEFT JOIN ser s ON s.id = m.ser_id
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN zassign za ON za.ser_id = s.id
         LEFT JOIN zacc z ON z.id = za.zacc_id
        ${where}
        ORDER BY m.on_date DESC NULLS LAST, m.id DESC`, params,
    )).map((r) => ({
      id: Number(r.id), mtType: String(r.mt_type),
      // 낱말은 서버가 만든다 — 한동안 이 표가 「general」 「plan」을 그대로 찍고 있었다 (D-R18 · C57)
      mtTypeLabel: mtTypeLabel(String(r.mt_type)),
      title: (r.title as string) ?? null,
      onDate: (r.on_date as string) ?? null,
      attendees: Number(r.attendees), confirmed: Number(r.confirmed), waiting: Number(r.waiting),
      hasMinutes: Boolean(r.minutes),
      serId: leadId(r.ser_id, true),
      startMin: r.start_min == null ? null : Number(r.start_min),
      endMin: r.end_min == null ? null : Number(r.end_min),
      placeLabel: r.ser_id == null ? null
        : r.mode === 'online' ? `온라인${r.zoom_label ? ` ${String(r.zoom_label)}` : ''}`
        : (r.room_name as string) ?? null,
    }));
  }

  /* ══ C96 — 「+ 회의 잡기」 · 「+ 기획 올리기」 (N-46 ①) ═══════════════════════ */

  /**
   * 회의를 잡는다 — **시간표에 하루짜리 회차를 만들고** 그 회차에 회의 기록을 건다 (원본 §63).
   *
   * 시각·강의실·온라인을 `mtrec` 에 적지 않는 이유는 두 가지다. ① 같은 사실이 두 곳에 살면
   * 시간표에서 옮겼을 때 갈린다(D-R22) ② **겹침을 아무도 안 막는다** — `ser_occ` 의 EXCLUDE 가
   * 강사·강의실·줌을 지키는데 `mtrec` 의 칸은 그 판정 밖이라, 회의가 수업이 쓰는 줌을 조용히 겹쳐 잡는다.
   * C95 가 컨설팅 회차에서 낸 길 그대로다.
   *
   * 참석자는 **답하기 전까지 「응답 대기」**(`confirmed NULL` · C57 의 세 값)이고, 그 사실이 곧
   * 컷 §63 의 「대기 4」다.
   */
  async createMeeting(viewerId: number, dto: MeetingCreateDto): Promise<MeetingCreateResultDto> {
    const timeIssue = dto.endMin <= dto.startMin
      ? '끝나는 시각이 시작보다 뒤여야 합니다' : null;
    if (timeIssue) throw new ConflictException({ code: 'BAD_RANGE', message: timeIssue });
    if (dto.mode === 'online' && dto.roomId != null) {
      throw new ConflictException({ code: 'MEETING_PLACE', message: '온라인 회의에는 강의실을 고르지 않습니다' });
    }
    if (dto.mode === 'offline' && dto.zaccId != null) {
      throw new ConflictException({ code: 'MEETING_PLACE', message: '현장 회의에는 줌 계정을 고르지 않습니다' });
    }
    const owner = await this.activeStaff(dto.ownerId ?? viewerId);
    const attendeeIds = [...new Set((dto.attendeeIds ?? []).filter((id) => id !== owner.id))];
    const title = dto.title?.trim() || null;

    // 트랜잭션은 **있는 길**로 연다 — `createPlan` 이 이미 `this.lead.manager` 를 타고 있어
    // `DataSource` 를 따로 주입하면 같은 연결로 가는 길이 두 벌이 된다 (D-R22)
    const q = this.lead.manager.connection.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      let serId: number;
      let unavailable: MeetingCreateResultDto['unavailable'];
      try {
        const written = await this.schedule.create({
          kindKey: 'meeting', subKey: MT_TYPE_SUB[dto.mtType as MtType], mode: dto.mode,
          fromDate: dto.onDate, toDate: dto.onDate, rrule: 'ONCE',
          startMin: dto.startMin, endMin: dto.endMin,
          // 시간표의 「강사」 자리가 곧 **주관자**다 — 그래서 주관자가 겹치면 EXCLUDE 가 막는다
          teacherId: owner.id, roomId: dto.roomId ?? null,
          title: title ?? mtTypeLabel(dto.mtType), studentIds: [],
        }, viewerId, q);
        serId = written.serIds[0]!;
        /*
         * 줌 계정은 **있는 길**로 붙인다 — `assignIn` 이 `zassign` 을 쓰고 **다시 투영**하므로
         * 그때 `ser_occ` 의 EXCLUDE 가 「그 시간에 그 계정이 비었는가」를 판정한다 (C48).
         * 여기서 직접 INSERT 하면 투영이 이미 끝나 **겹침을 아무도 안 본다.**
         */
        if (dto.zaccId != null) await this.zoom.assignIn(q.manager, viewerId, { serId, zaccId: dto.zaccId });
        unavailable = written.unavailable.map((u) => ({
          date: u.date, teacherName: u.teacherName, startMin: u.startMin, endMin: u.endMin, reason: u.reason,
        }));
      } catch (e) {
        // 겹침은 시간표(EXCLUDE · pg 23P01)가 막는다 — **무엇과** 부딪혔는지만 문장에 보탠다 (C93·C95 와 같은 자리)
        const pg = (e as { driverError?: { code?: string; constraint?: string }; code?: string }) ?? {};
        if ((pg.driverError?.code ?? pg.code) === '23P01') {
          throw new ConflictException({
            code: 'RESOURCE_CONFLICT',
            message: `같은 시간에 주관자·강의실·줌이 이미 잡혀 있습니다 — ${mtTypeLabel(dto.mtType)} · ${dto.onDate} · ${owner.name}`,
          });
        }
        throw e;
      }
      const [row] = (await q.query(
        `INSERT INTO mtrec (mt_type, title, on_date, ser_id) VALUES ($1,$2,$3::date,$4) RETURNING id`,
        [dto.mtType, title, dto.onDate, serId],
      )) as Array<{ id: string }>;
      const mtId = Number(row.id);
      // 주관자도 참석자다 — 만든 사람이 명단에서 빠지면 「대기 4」의 분모가 사람마다 다르다
      const everyone = [owner.id, ...attendeeIds];
      for (const staffId of everyone) {
        await q.query(
          `INSERT INTO mtattd (mt_id, staff_id) SELECT $1, $2 FROM staff WHERE id = $2 AND active ON CONFLICT DO NOTHING`,
          [mtId, staffId],
        );
      }
      const [{ n }] = (await q.query(
        `SELECT count(*)::text AS n FROM mtattd WHERE mt_id = $1`, [mtId],
      )) as Array<{ n: string }>;
      await q.query(
        `INSERT INTO noti (to_id, from_id, body, link, category)
         SELECT id, $1, $2, '/ops', 'schedule' FROM staff WHERE active AND id = ANY($3::bigint[]) AND id <> $1`,
        [viewerId, `${title ?? mtTypeLabel(dto.mtType)} — ${dto.onDate} ${OpsService.hm(dto.startMin)} 회의에 초대됐습니다`, everyone],
      );
      await q.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'MTREC',$2,'create',$3::jsonb)`,
        [viewerId, mtId, JSON.stringify({ mtType: dto.mtType, onDate: dto.onDate, serId, attendees: Number(n) })],
      );
      await q.commitTransaction();
      const [meeting] = await this.meetingRows('WHERE m.id = $1', [mtId]);
      return { meeting, attendees: Number(n), unavailable };
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
  }

  /**
   * 기획을 올린다 (원본 §61 「+ 기획 올리기」).
   *
   * **단계를 받지 않는다** — 올린 기획은 언제나 첫 단계이고, 옮기는 길은 §61 보드와 결재다.
   * 화면이 단계를 정하면 전이표가 두 벌이 된다(C90 의 상담 유입과 같은 규약).
   * 기한도 **제안**이다 — `due_approved_at` 은 비어 있고 대표가 승인해야 최종 승인이 열린다(C56).
   */
  async createPlan(viewerId: number, dto: PlanCreateDto): Promise<PlanCreateResultDto> {
    const title = dto.title.trim();
    if (!title) throw new ConflictException({ code: 'PLAN_TITLE_REQUIRED', message: '제목을 적어 주세요' });
    const owner = await this.activeStaff(dto.ownerId ?? viewerId);
    const id = await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(
        `INSERT INTO plan (title, stage, goal, ask, due_on, owner_id)
         VALUES ($1, $2, $3, $4, $5::date, $6) RETURNING id`,
        [title, PLAN_STAGES[0], dto.goal?.trim() || null, dto.ask?.trim() || null, dto.dueOn ?? null, owner.id],
      )) as Array<{ id: string }>;
      const planId = Number(row.id);
      if (owner.id !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category)
           SELECT id, $1, $2, '/ops', 'request' FROM staff WHERE id = $3 AND active`,
          [viewerId, `기획 「${title}」 담당이 됐습니다`, owner.id],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'PLAN',$2,'create',$3::jsonb)`,
        [viewerId, planId, JSON.stringify({ title, stage: PLAN_STAGES[0], ownerId: owner.id, dueOn: dto.dueOn ?? null })],
      );
      return planId;
    });
    const [plan] = (await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on,
              p.due_approved_at, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id WHERE p.id = $1`, [id],
    ));
    const due = (plan.due_on as string) ?? null;
    return {
      plan: {
        id, title, stage: String(plan.stage), stageLabel: planStageLabel(String(plan.stage)),
        goal: (plan.goal as string) ?? null, ask: (plan.ask as string) ?? null,
        dueOn: due, ownerName: (plan.owner_name as string) ?? null,
        overdueDays: 0, dueState: planDueState(due, plan.due_approved_at) as string,
      },
    };
  }

  /* ══ §67 컴플레인 — 읽기 한 벌 · 접수 · 처리 (C93 · J-96 · J-98 · J-101) ═══════ */

  /**
   * §67 카드 한 줄 — `GET /ops` 와 쓰기 응답이 같은 SELECT 를 쓴다.
   *
   * @param canMoney 「수강 종료 · 환불」이 서는가 (S5). 그 창이 부르는 `POST /accounting/withdrawals`
   *   (미리보기까지)는 `@Perm('canMoney')` 라 권한이 없으면 **창이 뜨자마자 403** 이었는데, 화면은
   *   그 줄에서 **아무 권한도 보지 않았다** — 네 자리 중 유일하게 불리언조차 없던 곳이다.
   */
  private async complaintRows(
    where: string, params: unknown[], today = todayKst(), canMoney = false,
  ): Promise<ComplaintDto[]> {
    return (await this.q(
      `SELECT c.id, c.area, c.student_id, s.name AS student_name, c.stage, c.body, c.action, c.result,
              to_char(c.created_at,'YYYY-MM-DD') AS created_at, c.owner_id, o.name AS owner_name,
              to_char(c.due_on,'YYYY-MM-DD') AS due_on, c.severity, c.teacher_changed
         FROM cpl c
         LEFT JOIN stu s ON s.id = c.student_id
         LEFT JOIN staff o ON o.id = c.owner_id
        ${where}
        ORDER BY (c.stage = 'received') DESC, c.created_at DESC, c.id DESC`,
      params,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      const open = CPL_OPEN_STAGES.includes(String(r.stage) as (typeof CPL_OPEN_STAGES)[number]);
      return {
        id: Number(r.id), area: String(r.area),
        studentId: leadId(r.student_id, true), studentName: (r.student_name as string) ?? null,
        stage: String(r.stage), body: String(r.body),
        action: (r.action as string) ?? null, result: (r.result as string) ?? null,
        createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
        // 갈래 이름·담당·심각도 낱말은 **서버가 준다** — 화면이 제 표를 들면 §67 칩과 §69 줄이 갈린다 (D-R18)
        areaLabel: cplAreaLabel(String(r.area)),
        ownerId: leadId(r.owner_id, true), ownerName: (r.owner_name as string) ?? null,
        dueOn: due,
        // 기한은 열린 건에만 센다 — 마무리한 건의 「N일 지남」은 재촉이 아니라 잡음이다 (§62 기획 기한과 같은 판정)
        overdueDays: open && due && due < today ? daysSince(due) : 0,
        severity: (r.severity as string) ?? null, severityLabel: cplSeverityLabel(r.severity as string | null),
        teacherChanged: Boolean(r.teacher_changed),
        /* 「수강 종료 · 환불」 단추 — 돈 권한 · 아직 안 끝난 건 · 학생이 붙어 있는 건 (S5 · D-R39).
           환불 창이 부르는 경로가 `canMoney` 라 이 셋이 서버의 조건과 같은 질문이다. */
        canWithdraw: canMoney && open && r.student_id != null,
      };
    });
  }

  private async complaintOne(id: number, canMoney = false): Promise<ComplaintDto> {
    const [row] = await this.complaintRows('WHERE c.id = $1', [id], todayKst(), canMoney);
    if (!row) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
    return row;
  }

  /**
   * 「+ 접수」 (J-96) — 접수는 언제나 `received` 다. 담당을 정했으면 그 사람에게 알림, LOG 는 같은 트랜잭션.
   * 학생·담당은 표가 있는지 서버가 본다 — 없는 id 를 받아 적으면 카드가 「문의자」로 조용히 바뀐다.
   */
  async createComplaint(viewerId: number, canMoney: boolean, dto: ComplaintCreateDto): Promise<ComplaintDto> {
    const body = dto.body.trim();
    if (!body) throw new ConflictException({ code: 'CPL_BODY_REQUIRED', message: '내용을 적어 주세요' });
    if (dto.studentId != null) {
      const [stu] = await this.q(`SELECT id FROM stu WHERE id = $1`, [dto.studentId]);
      if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '그 학생을 찾을 수 없습니다' });
    }
    const owner = dto.ownerId != null ? await this.activeStaff(dto.ownerId) : null;
    const id = await this.lead.manager.transaction(async (em) => {
      const [made] = (await em.query(
        `INSERT INTO cpl (area, student_id, stage, body, owner_id, due_on, severity)
         VALUES ($1, $2, 'received', $3, $4, $5::date, $6) RETURNING id`,
        [dto.area, dto.studentId ?? null, body, owner?.id ?? null, dto.dueOn ?? null, dto.severity ?? null],
      )) as Array<{ id: string }>;
      const cplId = leadId(made.id);
      if (owner && owner.id !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, '/ops?tab=complaint', 'request')`,
          [owner.id, viewerId, `컴플레인 담당 — ${cplAreaLabel(dto.area)} · ${body.slice(0, 40)}${dto.dueOn ? ` · 기한 ${dto.dueOn.slice(5)}` : ''}`],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'CPL',$2,'create','{}'::jsonb,$3::jsonb)`,
        [viewerId, cplId, JSON.stringify({ area: dto.area, studentId: dto.studentId ?? null, ownerId: owner?.id ?? null, dueOn: dto.dueOn ?? null, severity: dto.severity ?? null })],
      );
      return cplId;
    });
    return this.complaintOne(id, canMoney);
  }

  /**
   * 카드 처리 (J-101) — 보낸 칸만 고친다. 단계의 조건은 원본 §67 칸의 한 줄이 말한다:
   * 「대응」은 담당이 있어야(「담당을 정해야 합니다」), 「결과」는 결과 글이 있어야 한다(「마무리했습니다」).
   * 담당이 바뀌면 새 담당에게 알림. 판정은 고친 뒤의 값으로 한다 — 담당과 단계를 한 번에 보내도 된다.
   */
  async patchComplaint(viewerId: number, canMoney: boolean, id: number, dto: ComplaintPatchDto): Promise<ComplaintDto> {
    const hasAny = ['stage', 'ownerId', 'action', 'result', 'dueOn', 'severity'].some((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (!hasAny) throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 값을 하나 이상 보내야 합니다' });
    const owner = dto.ownerId != null ? await this.activeStaff(dto.ownerId) : null;
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(
        `SELECT id, stage, owner_id, action, result, to_char(due_on,'YYYY-MM-DD') AS due_on, severity FROM cpl WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; stage: string; owner_id: string | null; action: string | null; result: string | null; due_on: string | null; severity: string | null }>;
      if (!cur) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      const next = {
        stage: dto.stage ?? cur.stage,
        ownerId: dto.ownerId === undefined ? leadId(cur.owner_id, true) : (owner?.id ?? null),
        action: dto.action === undefined ? cur.action : (dto.action?.trim() || null),
        result: dto.result === undefined ? cur.result : (dto.result?.trim() || null),
        dueOn: dto.dueOn === undefined ? cur.due_on : dto.dueOn,
        severity: dto.severity === undefined ? cur.severity : dto.severity,
      };
      if (next.stage === 'acting' && next.ownerId == null) {
        throw new ConflictException({ code: 'CPL_OWNER_REQUIRED', message: '대응으로 옮기려면 담당을 정해야 합니다 (§67 「담당을 정해야 합니다」)' });
      }
      if (next.stage === 'closed' && !next.result) {
        throw new ConflictException({ code: 'CPL_RESULT_REQUIRED', message: '마무리하려면 결과를 적어야 합니다 (J-101)' });
      }
      await em.query(
        `UPDATE cpl SET stage = $2, owner_id = $3, action = $4, result = $5, due_on = $6::date, severity = $7 WHERE id = $1`,
        [id, next.stage, next.ownerId, next.action, next.result, next.dueOn, next.severity],
      );
      const ownerChanged = next.ownerId != null && next.ownerId !== leadId(cur.owner_id, true);
      if (ownerChanged && next.ownerId !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, '/ops?tab=complaint', 'request')`,
          [next.ownerId, viewerId, `컴플레인 담당 — #${id}${next.dueOn ? ` · 기한 ${String(next.dueOn).slice(5)}` : ''}`],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'CPL',$2,'update',$3::jsonb,$4::jsonb)`,
        [viewerId, id,
          JSON.stringify({ stage: cur.stage, ownerId: leadId(cur.owner_id, true), dueOn: cur.due_on, severity: cur.severity }),
          JSON.stringify({ stage: next.stage, ownerId: next.ownerId, dueOn: next.dueOn, severity: next.severity })],
      );
    });
    return this.complaintOne(id, canMoney);
  }

  private async activeStaff(id: number): Promise<{ id: number; name: string }> {
    const [st] = (await this.q(`SELECT id, name FROM staff WHERE id = $1 AND active`, [id])) as Array<{ id: string; name: string }>;
    if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
    return { id: leadId(st.id), name: st.name };
  }

  /* ══ §23 상담 머리 — 퍼널 · 담당 · 경고 (C86-a) ═══════════════════ */

  /**
   * 원본 §23 의 머리. **화면은 아무것도 세지 않는다** (D-R37 · N-19 의 교훈) —
   * 퍼널 여섯 칸, 등록률, 담당 칩, 경고 칩이 전부 여기서 나온다.
   *
   * 컷의 경고 다섯이 다 선다 — C86-a 의 셋(미수 · 스케줄 미생성 · 청구서 없음)에 C90 이 둘(「상담 오늘·지남」 ·
   * 「사후 관리 밀림」)을 더했다. 둘은 접촉 원장의 「다음은 언제」로 센다(N-44) — 카드 칩과 **같은 함수**(`nextChip`)라 수가 갈리지 않는다.
   */
  private async intakeHead(
    leads: ReadonlyArray<Pick<LeadDto, 'stage'> & Partial<Pick<LeadDto, 'ownerId' | 'ownerName' | 'source' | 'touches'>>>,
    canSeeAmounts: boolean,
    today = todayKst(),
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

    // 유입 경로 칩 줄 (N-44) — 여섯은 어휘라 0 이어도 서고, 「경로 없음」은 옛 건이 있을 때만 선다(보정 0 을 화면이 말한다)
    const bySource = new Map<string, number>();
    for (const l of leads) bySource.set(l.source ?? LEAD_SOURCE_UNSET, (bySource.get(l.source ?? LEAD_SOURCE_UNSET) ?? 0) + 1);
    const sources = LEAD_SOURCES.map((key) => ({ key, label: LEAD_SOURCE_LABEL[key], count: bySource.get(key) ?? 0 }));
    const unset = bySource.get(LEAD_SOURCE_UNSET) ?? 0;
    if (unset > 0) sources.push({ key: LEAD_SOURCE_UNSET as (typeof LEAD_SOURCES)[number], label: LEAD_SOURCE_UNSET_LABEL, count: unset });

    // 「다음은 언제」로 세는 셋 — 카드 칩과 같은 판정이다. 상담 예약이 오늘이거나 지났으면 「상담」, 그 밖은 「사후 관리」
    let consultDue = 0; let followUpLate = 0; let followUpSoon = 0;
    for (const l of leads) {
      const chip = this.nextChip(l.stage, l.touches?.[0] ?? null, today);
      if (chip?.key === 'consultDue') consultDue += 1;
      else if (chip?.key === 'followUpLate') followUpLate += 1;
      else if (chip?.key === 'followUpSoon') followUpSoon += 1;
    }

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
      // 아래 둘은 이 화면 안의 카드가 답이다 — 칩이 카드에 붙어 있으므로 갈 곳도 여기다 (D-R27)
      { key: 'consultDue', label: `상담 오늘·지남 ${consultDue}`, count: consultDue, amount: null, go: '/intake' },
      { key: 'followUpLate', label: `사후 관리 밀림 ${followUpLate}`, count: followUpLate, amount: null, go: '/intake' },
    ];

    // 도달 기록이 언제부터 있나 — §71 퍼널이 「언제부터의 값」인지 말할 근거 (N-45 · 옛 건 보정 0)
    const [since] = await this.q(
      `SELECT to_char(min(at) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS since FROM lead_stage_log WHERE stage = ANY($1)`,
      [[...INTAKE_FUNNEL_STAGES]],
    );

    return {
      funnel,
      enrollRate: total === 0 ? 0 : Math.round((enrolled / total) * 100),
      owners,
      alerts,
      // 낱말과 순서만 — 세는 일은 §24 화면이 **검색으로 걸러진 행** 위에서 한다 (IntakeStopDto 주석)
      stops: INTAKE_STOPS.map((key) => ({ key, label: INTAKE_STOP_LABEL[key] })),
      sources,
      touchKinds: LEAD_TOUCH_KINDS.map((key) => ({ key, label: LEAD_TOUCH_KIND_LABEL[key] })),
      followUpSoon,
      funnelSince: (since?.since as string) ?? null,
    };
  }

  /* ══ 상담 한 줄 — 읽기 한 벌 (C35 · C86 · C90) ═══════════════════════════════ */

  /**
   * 상담 건 한 줄의 모양은 **여기 하나**다 — `GET /ops` 의 목록과 쓰기 응답(신규 · 단계 이동 · 접촉 · 실패 · 되살림)이
   * 같은 SELECT 와 같은 판정을 쓴다. 두 곳이면 카드와 응답이 다른 말을 한다.
   *
   * 접촉 원장은 **한 번에** 읽는다(`lead_id = ANY`) — 건마다 물으면 18건에 열여덟 번이다.
   * N-25: failed 건의 되살릴 단계 판정 — 명시값 → 도달 기록 역순 → 미분류(null) — 는 명시값 없는 failed 건이 있을 때만 한 번 뒤따른다.
   */
  private async leadRows(where: string, params: unknown[], today = todayKst()): Promise<LeadDto[]> {
    const pending = new Map<number, LeadDto>();
    const rows = await this.q(
      `SELECT l.id, l.name, l.school, l.stage, l.stop_at, l.reason, l.owner_id, l.student_id, l.fail_from, l.source,
              to_char(l.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name
         FROM lead l LEFT JOIN staff o ON o.id = l.owner_id
        ${where}
        ORDER BY l.created_at DESC, l.id DESC`,
      params,
    );
    // 연결 ID 는 접촉 원장을 묻기 **전에** 검사한다 — 오염된 행이면 한 번의 조회로 끝나야 한다(ops-contract 회귀)
    const ids = rows.map((r) => { leadId(r.owner_id, true); leadId(r.student_id, true); return leadId(r.id); });
    const touchesBy = new Map<number, LeadTouchDto[]>();
    if (ids.length) {
      for (const t of await this.q(
        `SELECT t.id, t.lead_id, t.kind, t.note, to_char(t.next_on,'YYYY-MM-DD') AS next_on, t.by_id, s.name AS by_name,
                ${kstAt('t.at')} AS at
           FROM lead_touch t LEFT JOIN staff s ON s.id = t.by_id
          WHERE t.lead_id = ANY($1)
          ORDER BY t.lead_id, t.id DESC`,
        [ids],
      )) {
        const lid = leadId(t.lead_id);
        const list = touchesBy.get(lid) ?? [];
        list.push({
          id: leadId(t.id), kind: String(t.kind), kindLabel: leadTouchKindLabel(String(t.kind)), note: String(t.note),
          nextOn: (t.next_on as string) ?? null, byId: leadId(t.by_id, true), byName: (t.by_name as string) ?? null, at: String(t.at),
        });
        touchesBy.set(lid, list);
      }
    }
    const leads = rows.map((r): LeadDto => {
      const id = leadId(r.id);
      const failFrom = (r.fail_from as string) ?? null;
      const stage = String(r.stage);
      const failed = stage === 'failed';
      const touches = touchesBy.get(id) ?? [];
      const next = this.nextChip(stage, touches[0] ?? null, today);
      const dto: LeadDto = {
        id, name: String(r.name), school: (r.school as string) ?? null,
        ownerId: leadId(r.owner_id, true), studentId: leadId(r.student_id, true),
        stage, ownerName: (r.owner_name as string) ?? null,
        stopAt: (r.stop_at as string) ?? null, reason: (r.reason as string) ?? null,
        createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
        failFrom,
        revivalStage: failed ? failFrom : null,
        revivalSource: failed && failFrom ? 'explicit' : null,
        source: (r.source as string) ?? null, sourceLabel: leadSourceLabel(r.source as string | null),
        nextStages: leadNextStages(stage).map((key) => ({ key, label: INTAKE_STAGE_LABEL[key] })),
        touches,
        lastTouchAt: touches[0]?.at ?? null,
        nextOn: touches[0]?.nextOn ?? null,
        nextLabel: next?.label ?? null, nextTone: next?.tone ?? null,
      };
      if (failed && !failFrom) pending.set(id, dto);
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
    return leads;
  }

  /**
   * 카드 칩 한 줄 — 마지막 접촉의 「다음은 언제」로 센다 (N-44 결정문의 「상담 오늘·지남」 · 「사후 관리 임박·밀림」).
   * 상담 예약(`book`)은 「상담」, 그 밖은 「사후 관리」다. 등록 실패 건에는 재촉을 붙이지 않는다 — 끝난 결과다.
   * 등록 건은 붙는다(원본 §23 「해피콜 → 월간 상담」이 사후 관리다).
   */
  private nextChip(stage: string, last: LeadTouchDto | null, today: string): { label: string; tone: string; key: 'consultDue' | 'followUpLate' | 'followUpSoon' } | null {
    if (!last?.nextOn || stage === 'failed') return null;
    const consult = last.kind === 'book';
    const word = consult ? '상담' : '사후 관리';
    const d = daysUntil(last.nextOn, today);
    if (d < 0) return { label: consult ? `${word} ${-d}일 지남` : `${word} ${-d}일 밀림`, tone: 'danger', key: consult ? 'consultDue' : 'followUpLate' };
    if (d === 0) return { label: `${word} 오늘`, tone: 'warning', key: consult ? 'consultDue' : 'followUpSoon' };
    if (d <= 2) return { label: `${word} D-${d}`, tone: 'info', key: 'followUpSoon' };
    return null;
  }

  /* ══ 「+ 신규 문의」 · 단계 이동 · 접촉 기록 (C90 · N-44 · N-45 · A-01 · A-02 · A-03) ═══ */

  /**
   * 「+ 신규 문의」 — 유입은 언제나 1차 상담이다(원본 §23 「유입 즉시 1차 카드 생성」). 단계를 받지 않는다.
   * 도달 기록에 `first` 한 줄을 남긴다 — §71 퍼널의 「유입」이 여기서 센다(N-45). 첫 접촉 한 줄을 적었으면 접촉 원장의 첫 줄이 된다(어떻게 = 유입 경로).
   */
  async createLead(viewerId: number, dto: LeadCreateDto): Promise<LeadDto> {
    const name = dto.name.trim();
    if (!name) throw new ConflictException({ code: 'LEAD_NAME_REQUIRED', message: '이름을 적어 주세요' });
    if (!(LEAD_SOURCES as readonly string[]).includes(dto.source)) {
      throw new ConflictException({ code: 'LEAD_SOURCE_INVALID', message: '유입 경로는 카카오채널 · 전화 · 블로그 · 인스타그램 · 소개 · 워크인 중 하나입니다' });
    }
    const owner = dto.ownerId != null ? await this.activeStaff(dto.ownerId) : null;
    const note = dto.note?.trim() || null;
    const id = await this.lead.manager.transaction(async (em) => {
      const [made] = (await em.query(
        `INSERT INTO lead (name, school, owner_id, stage, source) VALUES ($1, $2, $3, 'first', $4) RETURNING id`,
        [name, dto.school?.trim() || null, owner?.id ?? null, dto.source],
      )) as Array<{ id: string }>;
      const lid = leadId(made.id);
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'first', $2)`, [lid, viewerId]);
      if (note) {
        await em.query(
          `INSERT INTO lead_touch (lead_id, kind, note, by_id) VALUES ($1, $2, $3, $4)`,
          [lid, LEAD_SOURCE_TOUCH_KIND[dto.source as LeadSource], note, viewerId],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'create','{}'::jsonb,$3::jsonb)`,
        [viewerId, lid, JSON.stringify({ name, school: dto.school?.trim() || null, ownerId: owner?.id ?? null, source: dto.source })],
      );
      return lid;
    });
    return this.leadOne(id);
  }

  /**
   * 단계 이동 (N-45) — 전이표(`LEAD_NEXT_STAGES`)에 있는 다음 단계로만 옮기고 **같은 트랜잭션에서** 도달 기록 한 줄을 남긴다.
   * 등록·등록 실패는 끝난 결과라 여기서 못 옮긴다(등록은 enroll · 실패는 fail/resume 이 각자의 길). 잠근 채 판정한다 — 두 사람이 동시에 옮기면 뒤 사람이 409 다.
   */
  async moveLeadStage(viewerId: number, id: number, dto: LeadStageMoveDto): Promise<LeadDto> {
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(`SELECT id, stage FROM lead WHERE id = $1 FOR UPDATE`, [id])) as Array<{ id: string; stage: string }>;
      if (!cur) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
      const allowed = leadNextStages(cur.stage);
      if (!allowed.length) {
        throw new ConflictException({ code: 'LEAD_LOCKED', message: `${intakeStageLabel(cur.stage)} 건은 단계를 옮길 수 없습니다 — 등록은 등록 확정, 실패는 되살리기로` });
      }
      if (!(allowed as readonly string[]).includes(dto.to)) {
        throw new ConflictException({
          code: 'LEAD_STAGE_INVALID',
          message: `${intakeStageLabel(cur.stage)}에서는 ${allowed.map((k) => intakeStageLabel(k)).join(' · ')}(으)로만 옮길 수 있습니다`,
        });
      }
      await em.query(`UPDATE lead SET stage = $2 WHERE id = $1`, [id, dto.to]);
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, $2, $3)`, [id, dto.to, viewerId]);
    });
    return this.leadOne(id);
  }

  /** 접촉 기록 (N-44) — append-only. 끝난 건에도 적을 수 있다(등록 뒤 해피콜 · 실패 뒤 재연락이 사후 관리다) */
  async addLeadTouch(viewerId: number, id: number, dto: LeadTouchWriteDto): Promise<LeadDto> {
    const note = dto.note.trim();
    if (!note) throw new ConflictException({ code: 'LEAD_TOUCH_NOTE_REQUIRED', message: '한 줄을 적어 주세요' });
    if (!(LEAD_TOUCH_KINDS as readonly string[]).includes(dto.kind)) {
      throw new ConflictException({ code: 'LEAD_TOUCH_KIND_INVALID', message: '접촉 방법은 전화 · 카카오톡 · 문자 · 방문 · 상담 예약 · 예약 불참 · 메모 중 하나입니다' });
    }
    const [row] = await this.q(`SELECT id FROM lead WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    await this.q(
      `INSERT INTO lead_touch (lead_id, kind, note, next_on, by_id) VALUES ($1, $2, $3, $4::date, $5)`,
      [id, dto.kind, note, dto.nextOn ?? null, viewerId],
    );
    return this.leadOne(id);
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
    const [row] = await this.leadRows('WHERE l.id = $1', [id]);
    if (!row) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    return row;
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

  /**
   * §65 기획 보고서 — 목표 → 과제 → 리서치 → 결정 요청
   *
   * `viewerId` 는 **자기 결재를 단추에서도 닫기 위해** 받는다. 쓰기 경로만 막으면 담당자에게는
   * 단추가 열려 보이고 누르면 거절당한다 — 화면과 서버가 같은 질문을 해야 한다 (D-R39).
   */
  async planDetail(id: number, canApprove: boolean, viewerId: number): Promise<PlanDetailDto | null> {
    const today = todayKst();
    const [p] = await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.research, p.ask, p.owner_id,
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
    /* 담당자 자신은 기한도 최종 승인도 못 한다 — 쓰기 경로(`decidePlanDue`·`reviewPlan`)와 같은 판정이다 */
    const isOwner = isSelfReview(p.owner_id, viewerId);
    const canDecideDue = canApprove && dueState === 'proposed' && !isOwner;
    const reviewBlockedReason =
      !canApprove ? '기획 결재는 대표만 합니다'
        : isOwner ? '자기가 담당인 기획은 자기가 결재할 수 없습니다'
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
      `SELECT id, due_on, due_approved_at, owner_id FROM plan WHERE id = $1`, [id],
    );
    if (!row) throw new NotFoundException('기획이 없습니다');
    // 올린 사람은 자기 기한을 스스로 승인하지 못한다 — `createPlan` 이 담당 기본값을 호출자로 박으므로
    // 이 검사가 없으면 「올리고 내가 승인」이 한 사람 안에서 닫힌다 (2026-09-20 검수)
    if (isSelfReview(row.owner_id, viewerId)) {
      throw new ConflictException({
        code: SELF_APPROVAL_CODE,
        message: '자기가 담당인 기획의 기한은 자기가 승인할 수 없습니다 — 내는 사람과 승인하는 사람은 다릅니다',
      });
    }
    if (!row.due_on) {
      throw new ConflictException({ code: 'NO_DUE', message: '제안된 기한이 없습니다' });
    }
    if (row.due_approved_at) {
      throw new ConflictException({ code: 'DUE_ALREADY_APPROVED', message: '이미 승인된 기한입니다' });
    }

    const beforeDue = { dueOn: row.due_on, approvedAt: row.due_approved_at };
    await this.lead.manager.transaction(async (em) => {
      if (dto.approve) {
        await em.query(`UPDATE plan SET due_approved_at = now(), due_approved_by = $2 WHERE id = $1`, [id, viewerId]);
      } else {
        await em.query(`UPDATE plan SET due_on = NULL, due_approved_at = NULL, due_approved_by = NULL WHERE id = $1`, [id]);
      }
      // 반려는 날짜를 지우는 파괴적 쓰기다 — 흔적이 없으면 무엇이 지워졌는지 아무도 모른다
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'plan', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, id, dto.approve ? 'due_approve' : 'due_reject',
          JSON.stringify(beforeDue),
          JSON.stringify(dto.approve ? { dueOn: row.due_on, approvedBy: viewerId } : { dueOn: null })],
      );
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /** 최종 승인 · 보완 요청 — **기한이 먼저 승인돼야 열린다** (원문 §61·§65) */
  async reviewPlan(viewerId: number, canApprove: boolean, id: number, dto: PlanReviewDto): Promise<PlanDetailDto> {
    const before = await this.planDetail(id, canApprove, viewerId);
    if (!before) throw new NotFoundException('기획이 없습니다');
    const [ownerRow] = await this.q(`SELECT owner_id FROM plan WHERE id = $1`, [id]);
    // 기한과 같은 규칙 — 올린 사람은 최종 승인도 하지 못한다
    if (isSelfReview(ownerRow?.owner_id, viewerId)) {
      throw new ConflictException({
        code: SELF_APPROVAL_CODE,
        message: '자기가 담당인 기획은 자기가 결재할 수 없습니다 — 내는 사람과 결재하는 사람은 다릅니다',
      });
    }
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
    return (await this.planDetail(id, canApprove, viewerId))!;
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
   *
   * **받는 사람은 활성 구성원이어야 한다**(S4). 여기만 `AND active` 가 없어 **그만둔 사람에게 할 일이
   * 배정됐다** — 이 파일의 다른 모든 자리(기획 담당·컴플레인 담당·상담 담당)는 `activeStaff` 를 쓴다.
   * 그러면 §64 운영 할 일에 아무도 안 하는 줄이 서고 알림은 아무도 안 읽는 수신함으로 간다.
   * 참석자 쪽은 이미 막고 있었다 (`INSERT INTO mtattd … WHERE id = $2 AND active`).
   */
  async assignMeetingTask(viewerId: number, id: number, dto: MeetingTaskCreateDto): Promise<MeetingDetailDto> {
    const [m] = await this.q(`SELECT id, title, mt_type FROM mtrec WHERE id = $1`, [id]);
    if (!m) throw new NotFoundException('회의가 없습니다');
    const to = await this.activeStaff(dto.toId);

    const name = (m.title as string) ?? mtTypeLabel(String(m.mt_type));
    await this.lead.manager.transaction(async (em) => {
      await em.query(
        `INSERT INTO todo (title, from_id, to_id, due_on, done, src, mt_id)
         VALUES ($1, $2, $3, $4, false, 'meeting', $5)`,
        [dto.title.trim(), viewerId, dto.toId, dto.dueOn ?? null, id],
      );
      if (to.id !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, '/ops?todo', 'request')`,
          [dto.toId, viewerId, `회의 할 일 — ${name}`],
        );
      }
    });
    return (await this.meetingDetail(id))!;
  }
}
