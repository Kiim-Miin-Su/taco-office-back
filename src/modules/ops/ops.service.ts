/** @file-guide
 * 목적: ops.service.ts — OpsService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import { ZoomService } from '../zoom/zoom.service';
import { daysUntil, overdueDays as daysSince, todayKst } from '../../lib/kst';
import { kstAt } from '../../lib/sql';
import { NOTI_TITLE } from '../../lib/noti';
import { todoGo, todoLessonGo, todoSourceLabel } from '../../lib/todo';
import {
  MFB_KIND_LABEL, mfbStateLabel, mktChannelLabel, mktItemLabel, mktTitle,
  MKT_CHANNEL_LABEL, MKT_CHANNELS, MKT_ITEM_LABEL, MKT_ITEMS,
  type MfbKind,
} from '../../lib/marketing-words';
import { MFB_ANSWER_KINDS } from '../../lib/marketing-words';
import {
  PLAN_DUE_STATE_LABEL, PLAN_OPEN_STAGES, PLAN_STAGES, PLAN_STAGE_LABEL, PLAN_STAGE_SUB,
  PLAN_WRITABLE_STAGES, planLockedMessage, planNextStages,
} from '../../lib/plan-words';
import { CPL_AREAS, CPL_AREA_LABEL, CPL_OPEN_STAGES, CPL_SEVERITIES, CPL_SEVERITY_LABEL, CPL_STAGES, CPL_STAGE_LABEL, CPL_STAGE_SUB, cplAreaLabel, cplSeverityLabel } from '../../lib/complaint-words';
import { CPL_REFUND_LOG, CPL_REQUESTERS, CPL_REQUESTER_LABEL, cplRequesterLabel } from '../../lib/complaint-words';
import {
  INTAKE_FUNNEL_STAGES, INTAKE_STAGES, INTAKE_STAGE_LABEL, INTAKE_STAGE_SUB, isIntakeFunnel,
  LEAD_SOURCES, LEAD_SOURCE_LABEL, LEAD_SOURCE_TOUCH_KIND, LEAD_SOURCE_UNSET, LEAD_SOURCE_UNSET_LABEL,
  LEAD_TOUCH_KINDS, LEAD_TOUCH_KIND_LABEL, intakeStageLabel, leadNextStages, leadSourceLabel, leadTouchKindLabel,
  LEAD_REASON_KINDS, LEAD_REASON_KIND_LABEL, LEAD_REASON_KIND_UNSET, LEAD_REASON_KIND_UNSET_LABEL,
  leadDueLabel, leadReasonKindLabel, leadRecontactDone, leadRecheckOn, leadStageDue, LEAD_APPT_KINDS, LEAD_APPT_KIND_LABEL,
  intakeEnrollRate, leadAftercareRows,
  type LeadAftercareCounts, type LeadSource,
} from '../../lib/intake-words';
import { leadCardActions, leadLessonLineLabel } from '../../lib/intake-words';
// W11 · N-87 중단 지점(실패 당시 단계) · N-86 사후 관리(할 일)
import {
  INTAKE_FAIL_STOPS, INTAKE_FAIL_STOP_LABEL, INTAKE_FAIL_STOP_SUB, intakeFailStop, leadCareDue, legacyStopLabel, type LeadCareState,
} from '../../lib/intake-words';
import { leadCareJson } from './lead-care';
import { writtenRows } from '../../lib/sql';
import { blocksSelfApproval, SELF_APPROVAL_CODE } from '../../lib/approval';
import { lockActiveStaff } from '../../lib/staff-lock';
import { maskPhone, phoneDigits, phoneDigitsDisplay } from '../notify/sender';
import { LEAD_DIAG_LATEST_JOIN, leadDiagFromRow } from './lead-diag.service';
import { LEAD_APPTS_JSON, LEAD_PLAN_JSON, leadApptsFromRow, leadPlanFromRow } from './lead-plan.service';
import { INV_OPEN } from '../../lib/rules';
import { kstDateOf, serStuEndedOn, sqlWordList } from '../../lib/sql';
import { startMinOf } from '../../lib/sql';
import { effectiveModeOf, endMinOf } from '../../lib/sql';
import {
  dueLabel, planDueKindLabel, planDueState, planStageLabel,
  type PlanDueState,
} from '../../lib/plan-words';
// W11 · N-72 공개 범위(planCan 한 곳) · N-95 기한 반려 보존 · PB-12-2 기대 상태 쓰기
import {
  PLAN_SHARES, PLAN_SHARE_LABEL, planCanSql, planDueChangedMessage, planShareLabel,
} from '../../lib/plan-words';
import { audit } from '../../lib/audit';
import { meetingNotiLink } from '../../lib/meeting-link';
import type { EntityManager } from 'typeorm';
import {
  MINUTES_HINT, MINUTES_TEMPLATES, MT_ATTEND_LABEL, MT_TYPES, MT_TYPE_SHORT, MT_TYPE_SUB,
  mtAttendState, mtTypeLabel, mtTypeOptions, mtTypeShort, type MtType,
} from '../../lib/meeting-words';
import type {
  IntakeAlertDto, IntakeFailReasonDto, IntakeHeadDto,
  ComplaintCreateDto, ComplaintDto, ComplaintPatchDto, ComplaintRefundDto,
  LeadCreateDto, LeadDto, LeadFailDto, LeadPatchDto, LeadStageMoveDto, LeadTouchDto, LeadTouchWriteDto,
  MfbCommentWriteDto, MfbEditDto, MfbPostDto, MfbReplyWriteDto, MfbThreadDto, OpsDto,
  PlanDetailDto, PlanDto, PlanDueDecisionDto, PlanDueRowDto, PlanPatchDto, PlanReviewDto,
  PlanStageMoveDto, PlanTaskCreateDto, PlanTaskDto,
  MeetingDetailDto, MeetingNoticeResultDto, MeetingTaskCreateDto, MeetingTaskDto, MinutesWriteDto,
  MeetingCreateDto, MeetingCreateResultDto, MeetingDto, OpsCountDto, OpsQueryDto,
  MarketingCreateDto, MarketingDto,
  MarketingPatchDto, PlanOwnerPatchDto, SuggestionDto, SuggestionReplyDto,
  PlanCreateDto, PlanCreateResultDto,
} from './ops.dto';

type R = Record<string, unknown>;

/**
 * 원본 §61 rework 카드의 **「보완 N」** — 세는 칸을 파지 않고 **감사 줄을 센다** (S6 · D-R22).
 *
 * `reviewPlan` 은 처음부터 `entity='plan' · action='rework'` 한 줄을 남기고 있었고, `log` 는
 * append-only 라 그 수가 어긋날 수가 없다. 사유(`plan.rework_reason`)는 다시 올릴 때 지워지는
 * **업무 상태**라 행에 두지만, 횟수는 **지워지지 않는 역사**라 여기서 센다.
 * 시드가 손으로 박은 `rework` 건은 이 줄이 없어 0 이다 — 정말로 모르기 때문이다 (N-25).
 */
const PLAN_REWORK_COUNT_SQL =
  `(SELECT count(*)::int FROM log l WHERE l.entity = 'plan' AND l.entity_id = p.id AND l.action = 'rework')`;

/**
 * §61 카드 한 줄의 SELECT — 목록과 「+ 기획 올리기」 응답이 같은 SELECT 를 쓴다 (w5).
 * 「과제 1/3」은 §65 보고서의 `tasks` 와 **같은 집합**(TODO `plan_id`)을 센다 — 세는 칸을 파지 않는다 (D-R22).
 */
const PLAN_ROW_SELECT = `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on,
         p.due_approved_at, p.owner_id, s.name AS owner_name,
         -- W11 · N-72 공개 범위 · N-95 반려된 기한 (옛 기획은 둘 다 NULL)
         p.share, to_char(p.due_rejected_on,'YYYY-MM-DD') AS due_rejected_on,
         ${PLAN_REWORK_COUNT_SQL} AS rework_count,
         (SELECT count(*) FILTER (WHERE t.done)::int FROM todo t WHERE t.plan_id = p.id) AS task_done,
         (SELECT count(*)::int FROM todo t WHERE t.plan_id = p.id) AS task_total
    FROM plan p LEFT JOIN staff s ON s.id = p.owner_id`;

/**
 * 회의의 **자리** 낱말 — §63 줄과 §66 머리가 같은 함수를 쓴다 (D-R18 · w5 66-2).
 * 이어진 회차가 없으면(옛 회의) null — 지어내지 않는다 (N-25).
 */
function meetingPlaceLabel(r: R): string | null {
  if (r.ser_id == null) return null;
  if (r.mode === 'online') return `온라인${r.zoom_label ? ` ${String(r.zoom_label)}` : ''}`;
  return (r.room_name as string) ?? null;
}

/**
 * 회의에 이어진 회차·강의실·줌 계정 — §63 줄과 §66 머리 · 회의 안내가 **같은 조인**을 쓴다.
 *
 * 강의실 · 줌 계정은 **그 회차의 투영**(`ser_occ.room_id` · `ser_occ.zacc_id`)에서 읽는다 — 투영이 이미 예외
 * (그 회차만 바꾼 강의실 · 방식 · 줌 계정)를 반영한다(A′2). 규칙의 값을 읽으면 그 회차만 온라인으로 바꾸며 붙인
 * 줌 계정 · 그 회차만 현장으로 바꾸며 고른 강의실이 장소 낱말에 서지 않는다.
 * 투영된 회차가 없을 때만(호라이즌 밖 · 투영 전 회차) 규칙의 강의실 · 규칙 대상 줌 배정으로 떨어진다.
 * 회차 키는 (m.ser_id, m.on_date) — `ser_occ` 의 (ser_id, on_date) 는 유일하다(`ser_occ_ser_date_uniq`).
 */
const MEETING_PLACE_JOINS = `
  LEFT JOIN ser s ON s.id = m.ser_id
  LEFT JOIN exc mx ON mx.ser_id = m.ser_id AND mx.on_date = m.on_date
  LEFT JOIN ser_occ mo ON mo.ser_id = m.ser_id AND mo.on_date = m.on_date
  LEFT JOIN room r ON r.id = CASE WHEN mo.ser_id IS NULL THEN s.room_id ELSE mo.room_id END
  LEFT JOIN zassign za ON za.ser_id = s.id
  LEFT JOIN zacc z ON z.id = CASE WHEN mo.ser_id IS NULL THEN za.zacc_id ELSE mo.zacc_id END`;

/**
 * 회의 회차의 실제 방식 — 시간표에서 그 회차만 온라인/현장으로 바꾼 예외(exc.mode)가 이긴다 (N-56 · lib/sql 한 조각).
 * 회차 키는 위 조인과 휴강 판정이 쓰는 (m.ser_id, m.on_date) 다.
 */
const MEETING_MODE = effectiveModeOf('mx', 's');

/**
 * 회의 회차의 시각 — 그 회차의 투영 구간(`mo.span`)에서 읽는다. 그 회차만 시간을 옮긴 회의도 옮긴 시각을 적는다(A′3).
 * 투영된 회차가 없을 때만(호라이즌 밖 · 투영 전) 규칙의 시각이다 — 장소(`MEETING_PLACE_JOINS`)와 같은 갈래.
 */
const MEETING_START_MIN = `CASE WHEN mo.ser_id IS NULL THEN s.start_min ELSE ${startMinOf('mo')} END`;
const MEETING_END_MIN = `CASE WHEN mo.ser_id IS NULL THEN s.end_min ELSE ${endMinOf('mo')} END`;

/**
 * 「+ 대표 지시」가 막히는 이유 — 읽기(`addTaskBlockedReason`)와 쓰기(409)가 **같은 문장**을 쓴다 (S5 · D-R22 · w5 65-4).
 * 권한이 먼저다(S1 의 순서). 끝난 기획에 과제를 더하면 「완료」가 거짓이 된다.
 */
function planTaskBlockedReason(stage: string, canApprove: boolean): string | null {
  if (!canApprove) return '대표 지시는 기획 결재 권한이 있는 사람만 적습니다';
  if (stage === 'done') return '끝난 기획에는 과제를 더하지 않습니다';
  return null;
}

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
   *   회의·마케팅 활동은 **그 날**(`on_date`), 할 일·기획은 **기한**(`due_on`). 날짜가 없는 줄은 가르지 않는다.
   */
  /**
   * @param canApprovePlan 기획 결재권자인가(`canCeoApprovePlan` · 대표 판정) — 지정 공개 기획이 보이는 셋 중 하나다 (N-72).
   *   **모르면 닫는다**(기본 false) — 인자를 안 준 호출자에게 지정 공개 기획이 새지 않는다.
   */
  async all(
    viewerId: number, canSeeAmounts: boolean, canComment: boolean, query: OpsQueryDto = {}, canApprovePlan = false,
  ): Promise<OpsDto> {
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

    // 「들어온 날」은 timestamptz 라 **KST 날짜로 바꿔서** 견준다 — 그대로 `<= to::date` 에 대면 끝날 자정에서 끊겨
    // 그날 들어온 건이 월별 목록에서 통째로 빠지고, 세션 시간대가 UTC 면 첫날 새벽이 앞 달로 간다 (all160 · 2026-09-30)
    // 한 줄의 모양은 leadRows 한 곳 — GET /ops 와 쓰기 응답이 같은 SELECT·같은 판정을 쓴다 (C90)
    const leadScope = scoped(kstDateOf('l.created_at'));
    const leads = await this.leadRows(leadScope.where, leadScope.params, today, canSeeAmounts);

    const cplScope = scoped(kstDateOf('c.created_at'), area ? { sql: 'c.area = $?', value: area } : undefined);
    const complaints = await this.complaintRows(cplScope.where, cplScope.params, today, canSeeAmounts);
    // 칩 줄의 건수는 **갈래 필터를 빼고** 센다 — 「수업 1」을 고른 뒤에도 다른 갈래의 수가 보여야 고를 수 있다
    const cplCountScope = scoped(kstDateOf('c.created_at'));
    // 같은 문장이 §67 「기한 지남 N」·컴플레인 탭 동그라미도 센다 (w5 · 67-2 · C-4) — 갈래를 골라도 흔들리지 않는다
    const { counts: areaCounts, overdue: cplOverdue } = await this.areaCounts(cplCountScope.where, cplCountScope.params, today);

    const todoScope = scoped('t.due_on');
    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on, t.to_id, s.name AS to_name, f.name AS from_name,
              -- W11 · N-71 §64 「연결 수업」 칩 — 회차 키 (ser_id, on_date)로 이어진 수업. 같은 SELECT 의 조인이라 왕복이 늘지 않는다
              t.ser_id, to_char(t.on_date,'YYYY-MM-DD') AS lesson_on,
              -- W11 A' 후속 2 — 「원본」 링크의 재료(출처 키) · 서랍과 같은 함수(lib/todo.todoGo)가 짓는다
              t.mt_id, t.cpl_id, t.cons_id, t.plan_id, t.lead_id,
              COALESCE(NULLIF(ls.title, ''), lsub.name, lkind.name, ls.kind_key) AS lesson_name,
              COALESCE(lsub.color, lkind.color) AS lesson_color,
              ${startMinOf('lo')} AS lesson_start,
              to_char(${kstDateOf('lower(lo.span)')},'YYYY-MM-DD') AS lesson_drawn
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id LEFT JOIN staff f ON f.id = t.from_id
         LEFT JOIN ser ls ON ls.id = t.ser_id
         LEFT JOIN sub lsub ON lsub.key = ls.sub_key
         LEFT JOIN kind lkind ON lkind.key = ls.kind_key
         LEFT JOIN ser_occ lo ON lo.ser_id = t.ser_id AND lo.on_date = t.on_date
        ${todoScope.where}
        ORDER BY t.done, t.due_on NULLS LAST, t.id`, todoScope.params,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      return {
        id: Number(r.id), title: String(r.title), toName: (r.to_name as string) ?? null,
        toId: r.to_id == null ? null : Number(r.to_id), fromName: (r.from_name as string) ?? null,
        srcLabel: todoSourceLabel(String(r.src)),
        dueOn: due, done: Boolean(r.done), src: String(r.src),
        overdueDays: !r.done && due && due < today ? daysSince(due) : 0,
        lesson: OpsService.todoLesson(r),
        // 출처로 돌아가는 링크 — 서랍 §15 와 같은 함수 한 곳(한 건을 여는 질의를 이미 읽는 화면만 · 수업은 연결 수업 칩과 같은 주소)
        go: todoGo({
          mtId: r.mt_id, cplId: r.cpl_id, consId: r.cons_id, planId: r.plan_id, leadId: r.lead_id,
          serId: r.ser_id, onDate: (r.lesson_on as string) ?? null, drawnOn: (r.lesson_drawn as string) ?? null,
        }),
      };
    });

    /* N-72 — 기획 목록은 `planCan` 을 지난 것만 싣는다. 판정은 lib/plan-words 한 곳이고 여기는 그 SQL 조각이다 */
    const planScope = scoped('p.due_on');
    const planParams = [...planScope.params, viewerId, canApprovePlan];
    const planVisible = planCanSql('p', `$${planParams.length - 1}`, `$${planParams.length}`);
    const plans = (await this.q(
      `${PLAN_ROW_SELECT}
        ${planScope.where ? `${planScope.where} AND ${planVisible}` : `WHERE ${planVisible}`}
        ORDER BY p.due_on NULLS LAST, p.id`, planParams,
    )).map((r) => OpsService.planRow(r, today));
    /* 기획 탭 동그라미 — 원본 §61·§64 컷의 「기획 2」·「단계 보드 ②」는 **대표 손이 가야 할 것**이다
       (검토 요청 1 + 보완 요청 1). 전체 건수를 달면 할 일이 없는 날에도 동그라미가 선다 (w5 · C-4) */
    const planPending = plans.filter((p) => p.stage === 'review' || p.stage === 'rework').length;

    const { planDues, planOverdue } = await this.planDeadlines(today, viewerId, canApprovePlan);

    const mtScope = scoped('m.on_date');
    const meetings = await this.meetingRows(mtScope.where, mtScope.params, today);
    const mtCountScope = scoped('m.on_date');
    // 같은 문장이 §63 머리 「54회 · 속기록 32」·「내 응답 대기 17」도 센다 (w5 · 63-5 · 63-6)
    // W11 · N-96 — 회의 탭 동그라미 「손봐야 할 것」(지난 회의 중 속기록이 빈 것)도 같은 문장이 센다 · 왕복 그대로
    const { counts: mtTypeCounts, minutes: mtMinutesCount, myWaiting: mtMyWaiting, needsMinutes: mtNeedsMinutes } =
      await this.mtTypeCounts(mtCountScope.where, mtCountScope.params, viewerId, today);

    // §59 도 기간을 탄다 — 활동한 날(`on_date`)로 가른다. 여기만 빠져 있어 칩이 「9월」이라 말하면서
    // 8월 활동을 그대로 보였다 (59-1). 날짜가 없는 옛 활동은 다른 목록처럼 가르지 않는다(rangeClause)
    const mktScope = scoped('m.on_date');
    const marketing = await this.marketingRows(mktScope.where, mktScope.params, canSeeAmounts);
    /* §59 필터 띠 「어디에 · 누가」와 머리의 항목 범례 · 「N건 M일 진행」(x5 · g6 59-4 · 59-5) —
       **받은 줄(같은 기간)에서 센다** · 왕복을 늘리지 않는다(ops-contract 가 조회 수를 센다) · 화면은 세지 않는다 (D-R37) */
    const mktChannelCounts = OpsService.countBy(marketing, (m) => m.channel, (m) => m.channelLabel);
    const mktByCounts = OpsService.countBy(
      marketing, (m) => (m.byId == null ? '__none__' : String(m.byId)), (m) => m.byName ?? '담당 없음');
    const mktItemCounts = OpsService.countBy(marketing, (m) => m.item, (m) => m.itemLabel);
    const mktDays = new Set(marketing.map((m) => m.onDate).filter((v): v is string => !!v)).size;

    const feedback = await this.feedbackThreads(viewerId);
    const feedbackNeedsFix = feedback.filter((t) => t.state === 'needs_fix').length;

    const suggestions = await this.suggestionRows();

    return {
      leads, complaints, todos, plans,
      // 칸 이름은 어휘라 데이터와 따로 간다 — 줄이 없는 칸도 이름을 갖는다 (D-R18)
      planStages: PLAN_STAGES.map((key) => ({ key, label: PLAN_STAGE_LABEL[key], sub: PLAN_STAGE_SUB[key] })),
      cplStages: CPL_STAGES.map((key) => ({ key, label: CPL_STAGE_LABEL[key], sub: CPL_STAGE_SUB[key] })),
      cplAreas: CPL_AREAS.map((key) => ({ key, label: CPL_AREA_LABEL[key] })),
      cplSeverities: CPL_SEVERITIES.map((key) => ({ key, label: CPL_SEVERITY_LABEL[key] })),
      // 문의자 관계 둘 (wave 6 · 67-5) — 「+ 접수」·처리 창의 낱말. 화면이 제 표를 들지 않는다 (D-R18)
      cplRequesters: CPL_REQUESTERS.map((key) => ({ key, label: CPL_REQUESTER_LABEL[key] })),
      planDues, planOverdue, meetings, marketing,
      feedback, feedbackNeedsFix, canComment,
      suggestions, canSeeAmounts,
      intakeHead: await this.intakeHead(leads, canSeeAmounts, today),
      range: { from: from ?? null, to: to ?? null, label: opsRangeLabel(from, to) },
      areaCounts, mtTypeCounts,
      // §64 상태별 담당 칩. 같은 기간·같은 TODO 목록에서 열린 것과 끝난 것을 각각 센다.
      todoOwnerCounts: OpsService.ownerCounts(todos, false),
      todoDoneOwnerCounts: OpsService.ownerCounts(todos, true),
      mtTypes: mtTypeOptions().map((o) => ({ key: o.key, label: o.label })),
      // 단추가 서는지도 서버다 (D-R39) — 지금은 이 화면을 볼 수 있으면 만들 수 있다
      canCreateMeeting: true, canCreatePlan: true,
      cplOverdue, planPending, mtMyWaiting, mtMinutesCount,
      // W11 · N-96 회의 탭 동그라미 · N-72 공개 범위 두 값의 낱말(「+ 기획 올리기」·§65 고르기 · D-R18)
      mtNeedsMinutes,
      planShares: PLAN_SHARES.map((key) => ({ key, label: PLAN_SHARE_LABEL[key] })),
      // §59 「+ 오늘 한 것」 폼의 낱말과 단추 (x5 · 59-3) — 어휘는 지금 코드의 이름표다(원문 어휘 맞춤은 N-29 ①)
      mktChannels: MKT_CHANNELS.map((key) => ({ key, label: MKT_CHANNEL_LABEL[key] })),
      mktItems: MKT_ITEMS.map((key) => ({ key, label: MKT_ITEM_LABEL[key] })),
      canCreateMarketing: true,
      mktChannelCounts, mktByCounts, mktItemCounts, mktDays,
    };
  }

  /**
   * §59 활동 한 줄 — 목록(`GET /ops`)과 「+ 오늘 한 것」 응답이 **같은 SELECT·같은 변환**을 쓴다
   * (C90 `leadRows` 와 같은 규약 · x5). 쓰기 응답이 다른 모양이면 화면이 두 벌을 들고 간다.
   */
  private async marketingRows(where: string, params: unknown[], canSeeAmounts: boolean): Promise<MarketingDto[]> {
    return (await this.q(
      `SELECT m.id, m.channel, m.item, m.url, m.result, m.title, m.memo, m.by_id, b.name AS by_name,
              to_char(m.on_date,'YYYY-MM-DD') AS on_date
         FROM mkt m LEFT JOIN staff b ON b.id = m.by_id
        ${where}
        ORDER BY (m.result->>'enrolled')::int DESC NULLS LAST, m.id`, params,
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
        // 카드 제목 아래 한 줄(W11 · N-29 ② · 원문 「상담 예약 4건 전환」) — 적은 그대로 · 옛 행은 null
        memo: (r.memo as string) ?? null,
        onDate: (r.on_date as string) ?? null,
        byId: leadId(r.by_id, true), byName: (r.by_name as string) ?? null,
        impressions: res.impressions ?? null, clicks: res.clicks ?? null,
        inquiries: res.inquiries ?? null, enrolled,
        // 비용은 대표만 (D-R39) — 서버가 안 내려보낸다
        cost: canSeeAmounts ? cost : null,
        costPerEnroll: canSeeAmounts && enrolled > 0 ? Math.round(cost / enrolled) : null,
      };
    });
  }

  /** 건의 목록과 답변 쓰기 응답의 단일 읽기 모양. 강사 화면과 같은 답변자·날짜를 싣는다. */
  private async suggestionRows(where = '', params: unknown[] = []): Promise<SuggestionDto[]> {
    return (await this.q(
      `SELECT g.id, s.name AS staff_name, g.category, g.body, g.state, g.reply,
              rb.name AS reply_by_name,
              to_char(g.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS created_at,
              to_char(g.reply_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS reply_on
         FROM suggestion g
         JOIN staff s ON s.id = g.staff_id
         LEFT JOIN staff rb ON rb.id = g.reply_by
        ${where}
        ORDER BY g.created_at DESC, g.id DESC`, params,
    )).map((r) => ({
      id: Number(r.id), staffName: String(r.staff_name), category: String(r.category),
      body: String(r.body), state: String(r.state), reply: (r.reply as string) ?? null,
      replyBy: (r.reply_by_name as string) ?? null, replyOn: (r.reply_on as string) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  /** 칩 줄 건수 — 건수가 있는 것만 · 많은 순 · 같으면 이름 · 키 (§64 담당 칩 `ownerCounts` 와 같은 차례) */
  private static countBy<T>(rows: T[], keyOf: (r: T) => string, labelOf: (r: T) => string): OpsCountDto[] {
    const counts = new Map<string, OpsCountDto>();
    for (const r of rows) {
      const key = keyOf(r);
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { key, label: labelOf(r), count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  }

  /**
   * §59 「+ 오늘 한 것」 — 활동 등록 · URL 첨부 (g6 59-3 · P1 · x5).
   *
   * 날짜를 안 주면 **오늘**이다(단추 이름 그대로) · 담당을 안 주면 **나**다(§60 「담당자 답변」을 쓸 사람).
   * 그만둔 사람에게는 달지 않는다 — 이 파일의 다른 담당 자리와 같은 판정(S4). 감사 줄은 같은 트랜잭션이다 —
   * 밖에서 남기면 쓰기는 되돌아가고 줄만 남는다(S7). 성과는 받지 않는다. 메모 한 줄(`mkt.memo`)은 받는다(W11 · N-29 ②).
   */
  async createMarketing(viewerId: number, canSeeAmounts: boolean, dto: MarketingCreateDto): Promise<MarketingDto> {
    const title = dto.title.trim();
    if (!title) throw new ConflictException({ code: 'MKT_TITLE_REQUIRED', message: '무엇을 했는지 적어 주세요' });
    // DTO 가 이미 막지만 서비스도 한 번 더 본다 — 모르는 코드가 표에 들어가면 화면이 코드값을 찍는다 (D-R18)
    if (!MKT_CHANNELS.includes(dto.channel) || !MKT_ITEMS.includes(dto.item)) {
      throw new ConflictException({ code: 'MKT_WORD_UNKNOWN', message: '채널과 항목은 목록에서 고르세요' });
    }
    const byId = dto.byId ?? viewerId;
    const onDate = dto.onDate ?? todayKst();
    const url = dto.url?.trim() ? dto.url.trim() : null;
    const memo = dto.memo?.trim() ? dto.memo.trim() : null;
    const id = await this.lead.manager.transaction(async (em) => {
      // 담당은 같은 트랜잭션에서 잠가 읽는다 — 확인과 저장 사이에 「사용 중지」가 커밋되지 않게 (CR-BE-04 · lib/staff-lock)
      const by = await lockActiveStaff(em, byId);
      if (!by) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
      const [row] = (await em.query(
        `INSERT INTO mkt (channel, item, url, on_date, title, by_id, memo) VALUES ($1, $2, $3, $4::date, $5, $6, $7) RETURNING id`,
        [dto.channel, dto.item, url, onDate, title, byId, memo],
      )) as Array<{ id: string }>;
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1, 'MKT', $2, 'create', $3::jsonb)`,
        [viewerId, row.id, JSON.stringify({ title, channel: dto.channel, item: dto.item, url, onDate, byId, memo })],
      );
      return leadId(row.id);
    });
    const [created] = await this.marketingRows('WHERE m.id = $1', [id], canSeeAmounts);
    return created;
  }

  /** §59 활동 수정 — 행 잠금, 앞뒤 감사, 담당 검증을 한 트랜잭션에 묶는다. */
  async patchMarketing(viewerId: number, canSeeAmounts: boolean, id: number, dto: MarketingPatchDto): Promise<MarketingDto> {
    if (!Object.keys(dto).length) throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 내용을 보내 주세요' });
    const title = dto.title === undefined ? undefined : dto.title.trim();
    if (dto.title !== undefined && !title) {
      throw new ConflictException({ code: 'MKT_TITLE_REQUIRED', message: '무엇을 했는지 적어 주세요' });
    }
    if ((dto.channel !== undefined && !MKT_CHANNELS.includes(dto.channel))
      || (dto.item !== undefined && !MKT_ITEMS.includes(dto.item))) {
      throw new ConflictException({ code: 'MKT_WORD_UNKNOWN', message: '채널과 항목은 목록에서 고르세요' });
    }
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(
        `SELECT id, title, channel, item, url, to_char(on_date,'YYYY-MM-DD') AS on_date, by_id, memo
           FROM mkt WHERE id = $1 FOR UPDATE`, [id],
      )) as R[];
      if (!cur) throw new NotFoundException({ code: 'MKT_NOT_FOUND', message: '마케팅 활동을 찾을 수 없습니다' });
      if (dto.byId != null) {
        // 활동 중 확인은 잠금과 함께 — 비활성화 UPDATE 와 충돌하는 FOR SHARE (CR-BE-04)
        const by = await lockActiveStaff(em, dto.byId);
        if (!by) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
      }
      const sets: string[] = [];
      const params: unknown[] = [id];
      const put = (col: string, value: unknown, cast = ''): void => {
        params.push(value); sets.push(`${col} = $${params.length}${cast}`);
      };
      if (title !== undefined) put('title', title);
      if (dto.channel !== undefined) put('channel', dto.channel);
      if (dto.item !== undefined) put('item', dto.item);
      if (dto.url !== undefined) put('url', dto.url?.trim() || null);
      if (dto.onDate !== undefined) put('on_date', dto.onDate ?? null, '::date');
      if (dto.byId !== undefined) put('by_id', dto.byId);
      if (dto.memo !== undefined) put('memo', dto.memo?.trim() || null);
      await em.query(`UPDATE mkt SET ${sets.join(', ')} WHERE id = $1`, params);
      const after = {
        title: title ?? cur.title, channel: dto.channel ?? cur.channel, item: dto.item ?? cur.item,
        url: dto.url === undefined ? cur.url : (dto.url?.trim() || null),
        onDate: dto.onDate === undefined ? cur.on_date : dto.onDate,
        byId: dto.byId === undefined ? leadId(cur.by_id, true) : dto.byId,
        memo: dto.memo === undefined ? cur.memo : (dto.memo?.trim() || null),
      };
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1,'MKT',$2,'edit',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({
          title: cur.title, channel: cur.channel, item: cur.item, url: cur.url,
          onDate: cur.on_date, byId: leadId(cur.by_id, true), memo: cur.memo,
        }), JSON.stringify(after)],
      );
    });
    const [updated] = await this.marketingRows('WHERE m.id = $1', [id], canSeeAmounts);
    return updated!;
  }

  /**
   * §61 카드 한 장 — 목록(`GET /ops`)과 「+ 기획 올리기」 응답이 **같은 변환**을 쓴다 (C90 `leadRows` 와 같은 규약).
   *
   * 「과제 1/3」·기한 낱말·기한 상태 이름을 여기서 만든다(w5 · 61-1~61-3). 기한 낱말은 §62 표와 **같은
   * `dueLabel`** 이고, 끝난(승인·완료) 기획에는 달지 않는다 — overdueDays 가 열린 기획에만 서는 것과 같은 판정이다.
   */
  private static planRow(r: R, today: string): PlanDto {
    const due = (r.due_on as string) ?? null;
    const rejectedOn = (r.due_rejected_on as string) ?? null;
    const stage = String(r.stage);
    const open = PLAN_OPEN_STAGES.includes(stage);
    const dueState = planDueState(due, r.due_approved_at, rejectedOn);
    /* 원문 §61 「D-2 08-19 · 기한 반려」 — 반려된 뒤에도 그 날짜의 남은 날 낱말이 선다 (N-95).
       붉게 칠하는 판정(overdueDays)은 **지금 기한**만 본다 — 반려된 날짜는 더 이상 마감이 아니다. */
    const shownDue = due ?? rejectedOn;
    const share = (r.share as string) ?? null;
    return {
      id: Number(r.id), title: String(r.title), stage,
      // 단계 이름을 만드는 자리는 서버 한 곳이다 — §61 보드 · §62 기한 표 · §65 보고서가 같이 쓴다 (D-R18)
      stageLabel: planStageLabel(stage),
      goal: (r.goal as string) ?? null, ask: (r.ask as string) ?? null,
      dueOn: due, ownerId: leadId(r.owner_id, true), ownerName: (r.owner_name as string) ?? null,
      overdueDays: open && due && due < today ? daysSince(due) : 0,
      dueState: dueState as string,
      reworkCount: Number(r.rework_count ?? 0),
      taskDone: Number(r.task_done ?? 0),
      taskTotal: Number(r.task_total ?? 0),
      dueLabel: open && shownDue ? dueLabel(daysUntil(shownDue, today)) : null,
      dueStateLabel: PLAN_DUE_STATE_LABEL[dueState as PlanDueState],
      dueRejectedOn: rejectedOn,
      share, shareLabel: planShareLabel(share),
    };
  }

  /**
   * §64 「연결 수업」 칩 한 칸 (N-71) — 「학습실 09:30」 · 누르면 그 회차가 열리는 시간표 주소.
   * 이름은 수업 상세 머리와 같은 차례(제목 → 과목 → 종류)이고 시각은 **그려지는 회차**의 시작이다(옮긴 회차도 맞다).
   * 회차가 투영에서 사라졌으면(규칙 삭제 · 기간 밖) 이름만 서고 이동이 없다 — 없는 회차로 보내지 않는다.
   */
  private static todoLesson(r: R): { label: string; color: string | null; go: string | null } | null {
    if (r.ser_id == null || r.lesson_on == null) return null;
    const name = (r.lesson_name as string) ?? '수업';
    const start = r.lesson_start == null ? null : Number(r.lesson_start);
    const drawn = (r.lesson_drawn as string) ?? null;
    return {
      label: start === null ? name : `${name} ${OpsService.hm(start)}`,
      color: (r.lesson_color as string)?.trim() || null,
      // 할 일의 「원본」과 같은 주소 한 곳(lib/todo · W11 A' 후속 2)
      go: todoLessonGo(r.ser_id, String(r.lesson_on), drawn),
    };
  }

  /** 분을 「11:00」으로 — 알림 한 줄에만 쓴다 */
  private static hm(min: number): string {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }

  /** §64 담당 칩 — 「전체 3 · Hoon 1 · Lauren 1 · 김범준 1」 (D-R37 · 화면이 세지 않는다) */
  private static ownerCounts(todos: Array<{ toId: number | null; toName: string | null; done: boolean }>, done: boolean): OpsCountDto[] {
    const counts = new Map<string, OpsCountDto>();
    for (const t of todos) {
      if (t.done !== done) continue;
      const key = t.toId == null ? '__none__' : String(t.toId);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { key, label: t.toName ?? '담당 없음', count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  }

  /** §67 갈래 칩 — **0건 갈래도 선다**(어휘이지 데이터가 아니다 · C66) */
  /**
   * §67 갈래 칩 — **0건 갈래도 선다**(어휘이지 데이터가 아니다 · C66).
   *
   * 같은 문장에서 **기한 지난 열린 건**도 센다(w5 · 67-2 · C-4) — 줄의 `overdueDays` 와 같은 판정(열린 단계 · 기한 < 오늘)이다.
   * 따로 물으면 `GET /ops` 한 번에 왕복이 는다(ops-contract 가 조회 수를 센다).
   */
  private async areaCounts(where: string, params: unknown[], today: string): Promise<{ counts: OpsCountDto[]; overdue: number }> {
    const p = [...params, [...CPL_OPEN_STAGES], today];
    const rows = await this.q<{ area: string; n: string; overdue: number }>(
      `SELECT c.area, count(*)::text AS n,
              count(*) FILTER (WHERE c.stage = ANY($${p.length - 1}::text[]) AND c.due_on < $${p.length}::date)::int AS overdue
         FROM cpl c ${where} GROUP BY c.area`, p,
    );
    const got = new Map(rows.map((r) => [String(r.area), Number(r.n)]));
    return {
      counts: CPL_AREAS.map((key) => ({ key, label: CPL_AREA_LABEL[key], count: got.get(key) ?? 0 })),
      overdue: rows.reduce((n, r) => n + Number(r.overdue ?? 0), 0),
    };
  }

  /**
   * §63 회의 종류 칩 — 같은 규약으로 0건도 선다.
   *
   * 같은 문장에서 머리의 「속기록 N」·「내 응답 대기 N」도 센다(w5 · 63-5 · 63-6) — 「썼다」는 줄의 `hasMinutes` 와
   * 같은 판정(빈 글은 안 쓴 것)이고, 응답 대기는 §66 의 세 값 중 `null` 이다.
   */
  private async mtTypeCounts(
    where: string, params: unknown[], viewerId: number, today = todayKst(),
  ): Promise<{ counts: OpsCountDto[]; minutes: number; myWaiting: number; needsMinutes: number }> {
    const p = [...params, viewerId, today];
    const rows = await this.q<{ mt_type: string; n: string; minutes: number; my_waiting: number; needs_minutes: number }>(
      `SELECT m.mt_type, count(*)::text AS n,
              count(*) FILTER (WHERE m.minutes IS NOT NULL AND m.minutes <> '')::int AS minutes,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM mtattd a WHERE a.mt_id = m.id AND a.staff_id = $${p.length - 1} AND a.confirmed IS NULL
              ))::int AS my_waiting,
              -- W11 · N-96 「손봐야 할 것」 — **이미 지난** 회의(날이 오늘보다 앞)인데 속기록이 빈 것.
              -- 「썼다」는 hasMinutes 와 같은 판정(빈 글은 안 쓴 것)이고, 날짜 없는 옛 회의는 지났는지 모르므로 세지 않는다 (N-25)
              count(*) FILTER (WHERE m.on_date < $${p.length}::date AND (m.minutes IS NULL OR m.minutes = ''))::int AS needs_minutes
         FROM mtrec m ${where} GROUP BY m.mt_type`, p,
    );
    const got = new Map(rows.map((r) => [String(r.mt_type), Number(r.n)]));
    return {
      // 칩 줄은 **짧은 이름**이다 — 원문 §63 「전체 · ●기획 · ●컨설팅 …」 (g6 63-7 · x5). 폼(mtTypes)은 긴 이름 그대로
      counts: MT_TYPES.map((key) => ({ key, label: MT_TYPE_SHORT[key], count: got.get(key) ?? 0 })),
      minutes: rows.reduce((n, r) => n + Number(r.minutes ?? 0), 0),
      myWaiting: rows.reduce((n, r) => n + Number(r.my_waiting ?? 0), 0),
      needsMinutes: rows.reduce((n, r) => n + Number(r.needs_minutes ?? 0), 0),
    };
  }

  /**
   * §63 회의 한 줄 — 목록과 쓰기 응답이 **같은 SELECT** 를 쓴다 (C90 `leadRows` 와 같은 규약).
   *
   * 시각·자리는 `mtrec` 이 아니라 **이어진 회차**에서 읽는다 — 옛 회의는 이어진 것이 없어 셋 다 null 이고,
   * 화면은 그 사실을 그대로 말한다(지어내지 않는다 · N-25).
   */
  private async meetingRows(where: string, params: unknown[], today = todayKst()): Promise<MeetingDto[]> {
    return (await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date, m.minutes, m.ser_id,
              ${MEETING_START_MIN} AS start_min, ${MEETING_END_MIN} AS end_min, ${MEETING_MODE} AS mode, r.name AS room_name, z.label AS zoom_label,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id)::int AS attendees,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed)::int AS confirmed,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed IS NULL)::int AS waiting,
              -- §63 줄의 이름 칩 (w5 · 63-2) — §66 상세의 참석 줄과 같은 순서(staff.id)·같은 세 값이다
              COALESCE((SELECT json_agg(json_build_object(
                         'staffId', a.staff_id, 'name', st.name, 'title', st.title, 'confirmed', a.confirmed) ORDER BY st.id)
                         FROM mtattd a JOIN staff st ON st.id = a.staff_id WHERE a.mt_id = m.id), '[]'::json) AS people
         FROM mtrec m
         ${MEETING_PLACE_JOINS}
        ${where}
        ORDER BY m.on_date DESC NULLS LAST, m.id DESC`, params,
    )).map((r) => {
      const onDate = (r.on_date as string) ?? null;
      return {
        id: Number(r.id), mtType: String(r.mt_type),
        // 낱말은 서버가 만든다 — 한동안 이 표가 「general」 「plan」을 그대로 찍고 있었다 (D-R18 · C57)
        mtTypeLabel: mtTypeLabel(String(r.mt_type)),
        mtTypeShort: mtTypeShort(String(r.mt_type)),
        title: (r.title as string) ?? null,
        onDate,
        attendees: Number(r.attendees), confirmed: Number(r.confirmed), waiting: Number(r.waiting),
        hasMinutes: Boolean(r.minutes),
        serId: leadId(r.ser_id, true),
        startMin: r.start_min == null ? null : Number(r.start_min),
        endMin: r.end_min == null ? null : Number(r.end_min),
        placeLabel: meetingPlaceLabel(r),
        attendeeList: ((r.people ?? []) as Array<{ staffId: unknown; name: string; title: string | null; confirmed: boolean | null }>)
          .map((a) => {
            const state = mtAttendState(a.confirmed);
            return { staffId: leadId(a.staffId), name: String(a.name), title: a.title ?? null, state, stateLabel: MT_ATTEND_LABEL[state] };
          }),
        // 「예정」 — 오늘도 아직 예정이다(끝났는지는 날짜만으로 모른다) · 날짜 없는 옛 회의는 예정이 아니다
        upcoming: onDate !== null && onDate >= today,
      };
    });
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
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT id, $1, $2, '/ops', 'schedule', $4 FROM staff WHERE active AND id = ANY($3::bigint[]) AND id <> $1`,
        [viewerId, `${title ?? mtTypeLabel(dto.mtType)} — ${dto.onDate} ${OpsService.hm(dto.startMin)} 회의에 초대됐습니다`, everyone, NOTI_TITLE.meetingInvite],
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
    /* N-72 — 새 기획은 원문 두 값 중 하나를 갖는다. 안 보내면 원문 첫 값(전체 공개)이다 — NULL 은 옛 기획만의 자리다 */
    const share = dto.share ?? 'all';
    const picks = await this.planPicks(share, dto.pickIds);
    const id = await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(
        `INSERT INTO plan (title, stage, goal, ask, due_on, owner_id, share)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7) RETURNING id`,
        [title, PLAN_STAGES[0], dto.goal?.trim() || null, dto.ask?.trim() || null, dto.dueOn ?? null, owner.id, share],
      )) as Array<{ id: string }>;
      const planId = Number(row.id);
      if (picks.length) {
        await em.query(`INSERT INTO plan_pick (plan_id, staff_id) SELECT $1, unnest($2::bigint[])`, [planId, picks]);
      }
      if (owner.id !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title)
           SELECT id, $1, $2, '/ops', 'request', $4 FROM staff WHERE id = $3 AND active`,
          [viewerId, `기획 「${title}」 담당이 됐습니다`, owner.id, NOTI_TITLE.planOwner],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'PLAN',$2,'create',$3::jsonb)`,
        // 공개 범위도 만든 순간의 사실이다 — 새 줄을 더하지 않고 있던 줄에 싣는다(중복 줄 금지 · N-73)
        [viewerId, planId, JSON.stringify({ title, stage: PLAN_STAGES[0], ownerId: owner.id, dueOn: dto.dueOn ?? null, share, pickIds: picks })],
      );
      return planId;
    });
    // 목록과 **같은 SELECT·같은 변환**이다 (w5) — 방금 만든 기획은 반려된 적도 과제도 없어 세어 봐야 0 이다
    const [plan] = await this.q(`${PLAN_ROW_SELECT} WHERE p.id = $1`, [id]);
    return { plan: OpsService.planRow(plan, todayKst()) };
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
    /* 차례 — **기한이 지난 열린 건이 맨 앞**(J-98 「목록에서 위로 정렬」 · all160 실브라우저 QA 2026-09-29).
       판정은 줄의 `overdueDays` 와 같다(열린 단계 · 기한 < 오늘 · 기한 없는 건은 아니다). 그다음은 예전 그대로 접수 → 최근 순. */
    const p = [...params, [...CPL_OPEN_STAGES], today];
    const rows = (await this.q(
      `SELECT c.id, c.area, c.student_id, s.name AS student_name, c.stage, c.body, c.action, c.result,
              to_char(c.created_at,'YYYY-MM-DD') AS created_at, c.owner_id, o.name AS owner_name,
              to_char(c.due_on,'YYYY-MM-DD') AS due_on, c.severity, c.teacher_changed,
              -- 문의자 관계 · 마무리한 날(KST) — wave 6 (67-5 · 67-6). 옛 행은 둘 다 NULL 그대로다 (N-25)
              c.requester, to_char(${kstDateOf('c.closed_at')},'YYYY-MM-DD') AS closed_on
         FROM cpl c
         LEFT JOIN stu s ON s.id = c.student_id
         LEFT JOIN staff o ON o.id = c.owner_id
        ${where}
        ORDER BY (c.stage = ANY($${p.length - 1}::text[]) AND c.due_on IS NOT NULL AND c.due_on < $${p.length}::date) DESC,
                 (c.stage = 'received') DESC, c.created_at DESC, c.id DESC`,
      p,
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
        // 누가 알렸는지 · 마무리한 날 — 낱말은 서버, 모르면 null(화면이 「미정」을 짓지 않는다 · wave 6)
        requester: (r.requester as string) ?? null,
        requesterLabel: cplRequesterLabel(r.requester as string | null),
        closedOn: (r.closed_on as string) ?? null,
        refunds: [] as ComplaintRefundDto[],
      };
    });
    /*
     * 컴플레인 → 환불 (J-99 · N-135) — 수강 종료가 같은 트랜잭션에 남긴 CPL 감사 줄을 **한 번에** 읽는다(줄마다 묻지 않는다).
     * 금액은 권한을 탄다 — 못 보면 줄은 서되 금액만 null 이다(D-R39 · 수강 종료 경로가 canMoney 이므로 같은 질문).
     */
    if (rows.length) {
      const refunds = await this.q(
        `SELECT l.entity_id, to_char(l.at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS at, l.after, s.name AS by_name
           FROM log l LEFT JOIN staff s ON s.id = l.actor_id
          WHERE l.entity = $1 AND l.action = $2 AND l.entity_id = ANY($3::bigint[])
          ORDER BY l.at, l.id`,
        [CPL_REFUND_LOG.entity, CPL_REFUND_LOG.action, rows.map((r) => r.id)],
      );
      const byCpl = new Map(rows.map((r) => [r.id, r]));
      for (const l of refunds) {
        const after = (l.after ?? {}) as { endedOn?: unknown; refundTotal?: unknown };
        byCpl.get(Number(l.entity_id))?.refunds.push({
          at: String(l.at),
          endedOn: String(after.endedOn ?? ''),
          refundTotal: canMoney && typeof after.refundTotal === 'number' ? after.refundTotal : null,
          byName: (l.by_name as string) ?? null,
        });
      }
    }
    return rows;
  }

  /** 문의자 관계 — DTO 가 먼저 막고 표의 CHECK 가 마지막에 막는다. 서비스도 한 번 더 본다(직접 호출 경로 · 67-5) */
  private static assertRequester(requester: string | null | undefined): void {
    if (requester != null && !(CPL_REQUESTERS as readonly string[]).includes(requester)) {
      throw new ConflictException({ code: 'CPL_REQUESTER_INVALID', message: '문의자 관계는 어머니 · 아버지 중 하나입니다' });
    }
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
    OpsService.assertRequester(dto.requester);
    if (dto.studentId != null) {
      const [stu] = await this.q(`SELECT id FROM stu WHERE id = $1`, [dto.studentId]);
      if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '그 학생을 찾을 수 없습니다' });
    }
    const owner = dto.ownerId != null ? await this.activeStaff(dto.ownerId) : null;
    const id = await this.lead.manager.transaction(async (em) => {
      const [made] = (await em.query(
        `INSERT INTO cpl (area, student_id, stage, body, owner_id, due_on, severity, requester)
         VALUES ($1, $2, 'received', $3, $4, $5::date, $6, $7) RETURNING id`,
        [dto.area, dto.studentId ?? null, body, owner?.id ?? null, dto.dueOn ?? null, dto.severity ?? null, dto.requester ?? null],
      )) as Array<{ id: string }>;
      const cplId = leadId(made.id);
      if (owner && owner.id !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, '/ops?tab=complaint', 'request', $4)`,
          [owner.id, viewerId, `컴플레인 담당 — ${cplAreaLabel(dto.area)} · ${body.slice(0, 40)}${dto.dueOn ? ` · 기한 ${dto.dueOn.slice(5)}` : ''}`, NOTI_TITLE.complaintOwner],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'CPL',$2,'create','{}'::jsonb,$3::jsonb)`,
        [viewerId, cplId, JSON.stringify({ area: dto.area, studentId: dto.studentId ?? null, ownerId: owner?.id ?? null, dueOn: dto.dueOn ?? null, severity: dto.severity ?? null, requester: dto.requester ?? null })],
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
    const hasAny = ['stage', 'ownerId', 'action', 'result', 'dueOn', 'severity', 'requester'].some((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (!hasAny) throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 값을 하나 이상 보내야 합니다' });
    OpsService.assertRequester(dto.requester);
    const owner = dto.ownerId != null ? await this.activeStaff(dto.ownerId) : null;
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(
        `SELECT id, stage, owner_id, action, result, to_char(due_on,'YYYY-MM-DD') AS due_on, severity, requester FROM cpl WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; stage: string; owner_id: string | null; action: string | null; result: string | null; due_on: string | null; severity: string | null; requester: string | null }>;
      if (!cur) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      const next = {
        stage: dto.stage ?? cur.stage,
        ownerId: dto.ownerId === undefined ? leadId(cur.owner_id, true) : (owner?.id ?? null),
        action: dto.action === undefined ? cur.action : (dto.action?.trim() || null),
        result: dto.result === undefined ? cur.result : (dto.result?.trim() || null),
        dueOn: dto.dueOn === undefined ? cur.due_on : dto.dueOn,
        severity: dto.severity === undefined ? cur.severity : dto.severity,
        requester: dto.requester === undefined ? cur.requester : dto.requester,
      };
      if (next.stage === 'acting' && next.ownerId == null) {
        throw new ConflictException({ code: 'CPL_OWNER_REQUIRED', message: '대응으로 옮기려면 담당을 정해야 합니다' });
      }
      if (next.stage === 'closed' && !next.result) {
        throw new ConflictException({ code: 'CPL_RESULT_REQUIRED', message: '마무리하려면 결과를 적어야 합니다' });
      }
      /*
       * 마무리 날짜 (67-6 · wave 6) — 「결과」로 **옮기는 순간** 찍는다(입력 칸이 아니다 · 원본 §67 결과 칸 카드의 「08-12」).
       * 결과 칸에 머무는 동안 글을 고쳐도 그 순간은 그대로 · 다시 열면 비운다(표의 cpl_closed_at_stage 가 열린 건의 날짜를 막는다).
       * 세 갈래는 고정 조각이라 SQL 에 사용자 값이 섞이지 않는다.
       */
      const closedAtSql = next.stage !== 'closed' ? 'NULL' : cur.stage === 'closed' ? 'closed_at' : 'now()';
      await em.query(
        `UPDATE cpl SET stage = $2, owner_id = $3, action = $4, result = $5, due_on = $6::date, severity = $7, requester = $8,
                        closed_at = ${closedAtSql} WHERE id = $1`,
        [id, next.stage, next.ownerId, next.action, next.result, next.dueOn, next.severity, next.requester],
      );
      const ownerChanged = next.ownerId != null && next.ownerId !== leadId(cur.owner_id, true);
      if (ownerChanged && next.ownerId !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, '/ops?tab=complaint', 'request', $4)`,
          [next.ownerId, viewerId, `컴플레인 담당 — #${id}${next.dueOn ? ` · 기한 ${String(next.dueOn).slice(5)}` : ''}`, NOTI_TITLE.complaintOwner],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'CPL',$2,'update',$3::jsonb,$4::jsonb)`,
        [viewerId, id,
          JSON.stringify({ stage: cur.stage, ownerId: leadId(cur.owner_id, true), dueOn: cur.due_on, severity: cur.severity, requester: cur.requester }),
          JSON.stringify({ stage: next.stage, ownerId: next.ownerId, dueOn: next.dueOn, severity: next.severity, requester: next.requester })],
      );
    });
    return this.complaintOne(id, canMoney);
  }

  private async activeStaff(id: number): Promise<{ id: number; name: string }> {
    const [st] = (await this.q(`SELECT id, name FROM staff WHERE id = $1 AND active`, [id])) as Array<{ id: string; name: string }>;
    if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
    return { id: leadId(st.id), name: st.name };
  }

  /**
   * 지정 공개의 **지정된 사람** (N-72) — 활동 중인 구성원만 · 겹침은 한 번.
   * 지정 공개가 아닌데 사람을 보내면 막는다 — 화면이 보낸 값을 조용히 버리면 「지정했는데 안 보인다」가 된다.
   */
  private async planPicks(share: string, pickIds: readonly number[] | undefined): Promise<number[]> {
    const ids = [...new Set(pickIds ?? [])];
    if (share !== 'picked') {
      if (ids.length) {
        throw new ConflictException({ code: 'PLAN_PICK_NOT_PICKED', message: '볼 사람은 지정 공개일 때만 고릅니다' });
      }
      return [];
    }
    if (!ids.length) return [];
    const found = (await this.q(`SELECT id FROM staff WHERE id = ANY($1::bigint[]) AND active`, [ids])) as Array<{ id: string }>;
    if (found.length !== ids.length) {
      throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '지정한 사람 중 활동 중이 아닌 구성원이 있습니다' });
    }
    return ids.sort((a, b) => a - b);
  }

  /**
   * 기획 한 행을 **잠그고** 읽는다 — 결재·고치기·옮기기가 모두 여기서 시작한다 (PB-12-2).
   *
   * 전에는 결재가 잠그지 않고 읽은 뒤 무조건 썼다. 그 사이 담당이 기한을 옮기면 대표가 본 적 없는 날짜가 승인됐고,
   * 두 결재자가 동시에 누르면 마지막 쓰기가 이겼다. 이제 판정은 **잠근 행**으로 한다.
   * 보이지 않는 기획(`planCan` · N-72)은 없는 것과 같다 — 404 다.
   */
  private async lockPlan(em: EntityManager, id: number, viewerId: number, canApprove: boolean): Promise<{
    id: number; title: string; stage: string; owner_id: string | null; share: string | null;
    due_on: string | null; due_approved_at: Date | null; due_rejected_on: string | null; visible: boolean;
  }> {
    const [row] = (await em.query(
      `SELECT p.id, p.title, p.stage, p.owner_id, p.share,
              to_char(p.due_on,'YYYY-MM-DD') AS due_on, p.due_approved_at,
              to_char(p.due_rejected_on,'YYYY-MM-DD') AS due_rejected_on,
              ${planCanSql('p', '$2', '$3')} AS visible
         FROM plan p WHERE p.id = $1 FOR UPDATE OF p`,
      [id, viewerId, canApprove],
    )) as Array<{ id: string; title: string; stage: string; owner_id: string | null; share: string | null;
      due_on: string | null; due_approved_at: Date | null; due_rejected_on: string | null; visible: boolean }>;
    if (!row || !row.visible) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: '기획을 찾을 수 없습니다' });
    return { ...row, id: leadId(row.id) };
  }

  /**
   * 결재 단추 셋이 **열리는가** — 읽기(`planDetail`)와 쓰기(`decidePlanDue`·`reviewPlan`)가 같은 함수를 부른다 (D-R39 · D-R22).
   * 쓰기는 잠근 행으로 부르므로 경합 뒤에도 판정이 지금 상태를 본다 (PB-12-2).
   */
  private static planGates(
    p: { stage: string; owner_id: unknown; due_on: string | null; due_approved_at: unknown; due_rejected_on?: string | null },
    canApprove: boolean, viewerId: number,
  ): { dueState: PlanDueState; canDecideDue: boolean; reworkBlockedReason: string | null; reviewBlockedReason: string | null } {
    const dueState = planDueState(p.due_on, p.due_approved_at, p.due_rejected_on ?? null);
    const open = PLAN_OPEN_STAGES.includes(p.stage);
    /* 담당자 자신은 기한도 최종 승인도 못 한다 — 기한과 최종은 **서로 다른 자리**다(한쪽만 다시 막는 날 따로 물을 수 있어야 한다) */
    const ownerBlocksDue = blocksSelfApproval('plan-due', p.owner_id, viewerId);
    const ownerBlocksReview = blocksSelfApproval('plan', p.owner_id, viewerId);
    const canDecideDue = canApprove && dueState === 'proposed' && !ownerBlocksDue;
    /* S6 — 「검토 요청」이 결재의 전제다. 「보완 요청」은 최종 승인과 **같은 문을 지나되 기한 승인을 보지 않는다**
       — 원문 규칙이 막는 것은 「최종 승인」뿐이다(슬라이드 61·65 · 컷 §65 의 살아 있는 「보완 요청」 · g6 65-7 · x5). */
    const reworkBlockedReason =
      !canApprove ? '기획 결재는 대표만 합니다'
        : ownerBlocksReview ? '자기가 담당인 기획은 자기가 결재할 수 없습니다'
          : !open ? '이미 끝난 기획입니다'
            : p.stage !== 'review' ? '아직 검토 요청이 올라오지 않았습니다'
              : null;
    const reviewBlockedReason = reworkBlockedReason ?? (dueState !== 'approved' ? '기한부터 승인하세요' : null);
    return { dueState, canDecideDue, reworkBlockedReason, reviewBlockedReason };
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
    leads: ReadonlyArray<Pick<LeadDto, 'stage'> & Partial<Pick<LeadDto, 'name' | 'ownerId' | 'ownerName' | 'source' | 'touches' | 'reasonKind'>>>,
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
    const enrolled = funnel.find((f) => f.key === 'enrolled')?.count ?? 0;
    const failedCount = funnel.find((f) => f.key === 'failed')?.count ?? 0;

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

    // 차례는 원본 §23 경고 줄 그대로다 — 상담 오늘·지남 · 사후 관리 밀림 · 미수 · 스케줄 미생성 · 청구서 없음 (wave3 23-08)
    const alerts: IntakeAlertDto[] = [
      // 앞의 둘은 이 화면 안의 카드가 답이다 — 칩이 카드에 붙어 있으므로 갈 곳도 여기다 (D-R27)
      { key: 'consultDue', label: `상담 오늘·지남 ${consultDue}`, count: consultDue, amount: null, go: '/intake' },
      { key: 'followUpLate', label: `사후 관리 밀림 ${followUpLate}`, count: followUpLate, amount: null, go: '/intake' },
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

    /*
     * §24 「실패 사유 N건」 막대 (24-05) — 지금 실패인 건을 분류로 센다. 다섯은 어휘라 0 이어도 서고,
     * 분류가 없는 건(옛 실패 · 분류 전)은 「분류 안 됨」 한 줄로 있을 때만 선다 — 이 줄이 없으면 머리의 「등록 실패 N」과 합이 갈린다 (N-19).
     */
    const reasonNames = new Map<string, string[]>();
    for (const l of leads) {
      if (l.stage !== 'failed') continue;
      const key = l.reasonKind ?? LEAD_REASON_KIND_UNSET;
      reasonNames.set(key, [...(reasonNames.get(key) ?? []), l.name ?? '']);
    }
    const failReasons: IntakeFailReasonDto[] = LEAD_REASON_KINDS.map((key) => ({
      key, label: LEAD_REASON_KIND_LABEL[key], count: reasonNames.get(key)?.length ?? 0, names: reasonNames.get(key) ?? [],
    }));
    const unclassified = reasonNames.get(LEAD_REASON_KIND_UNSET) ?? [];
    if (unclassified.length) {
      failReasons.push({ key: LEAD_REASON_KIND_UNSET, label: LEAD_REASON_KIND_UNSET_LABEL, count: unclassified.length, names: unclassified });
    }

    // 도달 기록이 언제부터 있나 — §71 퍼널이 「언제부터의 값」인지 말할 근거 (N-45 · 옛 건 보정 0)
    const [since] = await this.q(
      `SELECT to_char(min(at) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS since FROM lead_stage_log WHERE stage = ANY($1)`,
      [[...INTAKE_FUNNEL_STAGES]],
    );

    return {
      funnel,
      // 등록 / (등록 + 등록 실패) — 원본 §23 「등록 3 · 실패 6 · 33%」 (23-19 · N-22 채택 방향). 식은 intake-words 한 곳
      enrollRate: intakeEnrollRate(enrolled, failedCount),
      owners,
      alerts,
      // 낱말 · 순서 · 설명 한 줄만 — 세는 일은 §24 화면이 **검색으로 걸러진 행** 위에서 한다 (IntakeStopDto 주석)
      // W11 · N-87: 넷은 실패 당시 단계(깔때기 차례) — 원문 §24 컷의 낱말 그대로
      stops: INTAKE_FAIL_STOPS.map((key) => ({ key, label: INTAKE_FAIL_STOP_LABEL[key], sub: INTAKE_FAIL_STOP_SUB[key] })),
      sources,
      touchKinds: LEAD_TOUCH_KINDS.map((key) => ({ key, label: LEAD_TOUCH_KIND_LABEL[key] })),
      followUpSoon,
      funnelSince: (since?.since as string) ?? null,
      failReasons,
      apptKinds: LEAD_APPT_KINDS.map((key) => ({ key, label: LEAD_APPT_KIND_LABEL[key] })),
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
  private async leadRows(where: string, params: unknown[], today = todayKst(), canSeeAmounts = false): Promise<LeadDto[]> {
    const pending = new Map<number, LeadDto>();
    // 「오늘」을 칩과 같은 값으로 SQL 에도 넘긴다 — where 조각의 자리 뒤에 붙여 번호가 겹치지 않는다 (23-11 등록 수업)
    const sqlParams = [...params, today];
    const TODAY = `$${sqlParams.length}::date`;
    // 최신 진단 점수 한 줄은 같은 SELECT 에 LATERAL 로 붙인다 — 카드마다 묻지 않는다(DQ1 · 왕복 0)
    const rows = await this.q(
      `SELECT l.id, l.name, l.school, l.stage, l.stop_at, l.reason, l.owner_id, l.student_id, l.fail_from, l.source,
              l.grade, l.reason_kind, to_char(l.recheck_on,'YYYY-MM-DD') AS recheck_on,
              l.parent_relation, l.parent_phone, l.want,
              -- 배치안 초안 · 2차/진단 일정(23-15 · 23-16)도 같은 SELECT 의 JSON 한 칸씩이다 — 카드마다 묻지 않는다(왕복 수 그대로)
              ${LEAD_PLAN_JSON}, ${LEAD_APPTS_JSON},
              to_char(l.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name,
              -- 실패한 순간 — 도달 기록의 마지막 「등록 실패」 줄(24-04 · 재연락 판정의 기준). 옛 건은 줄이 없어 NULL (N-25)
              CASE WHEN l.stage = 'failed' THEN
                (SELECT ${kstAt('max(g.at)')} FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'failed') END AS failed_at,
              -- 지금 단계에 들어온 날(KST) — 단계 기한(SLA)의 기준 (23-12). 1차는 유입이 곧 도달이라 기록이 없으면 접수일이다
              CASE WHEN l.stage IN (${sqlWordList(INTAKE_FUNNEL_STAGES)}) THEN COALESCE(
                (SELECT to_char(${kstDateOf('max(g.at)')},'YYYY-MM-DD') FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = l.stage),
                CASE WHEN l.stage = 'first' THEN to_char(${kstDateOf('l.created_at')},'YYYY-MM-DD') END) END AS stage_entered_on,
              -- 등록 카드의 사후 관리 줄(23-18) — 그 학생의 청구서 · 교재 · 안내를 **읽기만** 한다. 같은 SELECT 라 왕복 수 그대로
              CASE WHEN l.stage = 'enrolled' AND l.student_id IS NOT NULL THEN json_build_object(
                'inv',        (SELECT count(*) FROM inv i WHERE i.student_id = l.student_id),
                'bookOk',     (SELECT count(*) FROM issue x WHERE x.student_id = l.student_id AND x.state = 'ok'),
                'bookWait',   (SELECT count(*) FROM issue x WHERE x.student_id = l.student_id AND x.state IN ('wait','auto')),
                'guideSent',  (SELECT count(*) FROM guide g WHERE g.student_id = l.student_id AND g.state IN ('sent','read')),
                'guideDraft', (SELECT count(*) FROM guide g WHERE g.student_id = l.student_id AND g.state IN ('draft','ready'))
              ) END AS aftercare,
              -- W11 · N-86 — 등록 카드의 해피콜 · 첫 월간 상담(담당의 할 일)과 띠. 같은 SELECT 의 JSON 한 칸이라 왕복 수 그대로
              CASE WHEN l.stage = 'enrolled' THEN ${leadCareJson('l.id')} END AS care_json,
              -- 등록 카드의 「등록 수업」(23-11 · wave 6) — 그 학생의 지금 명단. 끝난 명단(수강 종료)·끝난 규칙은 빠진다. 시간표가 정본이고 읽기만 한다
              CASE WHEN l.stage = 'enrolled' AND l.student_id IS NOT NULL THEN (
                SELECT COALESCE(json_agg(json_build_object(
                         'kind_name', k.name, 'sub_name', sb.name, 'rrule', s.rrule, 'teacher_name', t.name
                       ) ORDER BY s.from_date, s.id), '[]'::json)
                  FROM ser_stu ss JOIN ser s ON s.id = ss.ser_id JOIN kind k ON k.key = s.kind_key
                  LEFT JOIN sub sb ON sb.key = s.sub_key LEFT JOIN staff t ON t.id = s.teacher_id
                 WHERE ss.student_id = l.student_id
                   AND NOT ${serStuEndedOn('ss', TODAY)}
                   AND (s.to_date IS NULL OR s.to_date >= ${TODAY})
              ) END AS lessons_json,
              ld.*
         FROM lead l LEFT JOIN staff o ON o.id = l.owner_id
         ${LEAD_DIAG_LATEST_JOIN}
        ${where}
        ORDER BY l.created_at DESC, l.id DESC`,
      sqlParams,
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
      const failedAt = failed ? ((r.failed_at as string) ?? null) : null;
      // 재연락 (24-06) — 실패 뒤에 접촉 원장에 줄이 있으면 완료. 실패 시각을 모르면 판정하지 않는다
      const recontactDone = failed ? leadRecontactDone(failedAt, touches[0]?.at ?? null) : null;
      const recontactOn = touches[0]?.nextOn ?? null;
      const enteredOn = (r.stage_entered_on as string) ?? null;
      const appts = leadApptsFromRow(r);
      const second = appts.find((a) => a.kind === 'second') ?? null;
      const recheckOn = leadRecheckOn(stage, (r.recheck_on as string) ?? null, enteredOn);
      // 사후 관리 할 일(N-86) — 등록 건만. 해피콜 · 첫 월간 상담 두 줄과 띠가 이 값을 읽는다
      const care: LeadCareState | null = r.care_json == null ? null : {
        happy: ((r.care_json as R).happy as LeadCareState['happy']) ?? null,
        firstMonthly: ((r.care_json as R).firstMonthly as LeadCareState['firstMonthly']) ?? null,
      };
      const dto: LeadDto = {
        id, name: String(r.name), school: (r.school as string) ?? null,
        ownerId: leadId(r.owner_id, true), studentId: leadId(r.student_id, true),
        stage, ownerName: (r.owner_name as string) ?? null,
        stopAt: (r.stop_at as string) ?? null, reason: (r.reason as string) ?? null,
        createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
        failFrom,
        revivalStage: failed ? failFrom : null,
        revivalSource: failed && failFrom ? 'explicit' : null,
        // §24 중단 지점(N-87) — 판정(명시값 → 도달 기록)이 다 끝난 뒤 아래에서 채운다
        failStopKey: null, failStopLabel: null,
        // 옛 중단 지점 — 읽기 전용 기록의 낱말(대응표로 옮기지 않는다 · N-25)
        stopAtLabel: legacyStopLabel(r.stop_at as string | null),
        source: (r.source as string) ?? null, sourceLabel: leadSourceLabel(r.source as string | null),
        nextStages: leadNextStages(stage).map((key) => ({ key, label: INTAKE_STAGE_LABEL[key] })),
        touches,
        lastTouchAt: touches[0]?.at ?? null,
        nextOn: touches[0]?.nextOn ?? null,
        nextLabel: next?.label ?? null, nextTone: next?.tone ?? null,
        latestDiag: leadDiagFromRow(r),
        grade: (r.grade as string) ?? null,
        // A-01 — 연락처는 숫자만 저장하고 보이는 모양은 서버가 만든다(보호자와 같은 함수)
        parentRelation: (r.parent_relation as string) ?? null,
        parentPhone: (r.parent_phone as string) ?? null,
        parentPhoneDisplay: phoneDigitsDisplay((r.parent_phone as string) ?? null),
        want: (r.want as string) ?? null,
        reasonKind: (r.reason_kind as string) ?? null,
        reasonKindLabel: leadReasonKindLabel(r.reason_kind as string | null),
        failedAt: failedAt ? failedAt.slice(0, 10) : null,
        recontact: recontactDone === null ? null : {
          done: recontactDone,
          label: recontactDone ? '재연락 완료' : '재연락 대기',
          tone: recontactDone ? 'info' : 'warning',
          on: recontactOn,
          dueLabel: recontactOn ? leadDueLabel(recontactOn, today) : null,
        },
        // 등록 건은 사후 관리 띠(N-86 · 원본 §23 「해피콜 D-3」 · 「정기 관리 중」) — 깔때기 안은 단계 기한(23-12)
        stageDue: care ? leadCareDue(care, today) : leadStageDue(stage, enteredOn, today,
          // 보류는 재확인 날짜 · 2차 대기는 잡아 둔 2차 일정이 기한이다(원본 §23 「2차 상담 2026-08-26 14:30 · D-5」 · 23-15 · 23-16)
          stage === 'hold' && recheckOn ? { dueOn: recheckOn }
            : stage === 'wait2nd' && second ? { dueOn: second.onDate, task: `2차 상담 ${second.onDate} ${OpsService.hm(second.startMin)}` }
            : null),
        plan: leadPlanFromRow(r, canSeeAmounts),
        appts,
        recheckOn,
        aftercare: r.aftercare ? leadAftercareRows(r.aftercare as LeadAftercareCounts, care ?? undefined) : null,
        // 「등록 수업」 한 줄 (23-11) — 낱말은 배치안과 같은 함수. 단발은 줄이 없다(정기 수업이 아니다)
        lessons: r.lessons_json == null ? null
          : (Array.isArray(r.lessons_json) ? (r.lessons_json as R[]) : [])
            .map((x) => leadLessonLineLabel({
              subName: (x.sub_name as string) ?? null, kindName: (x.kind_name as string) ?? null,
              rrule: String(x.rrule ?? ''), teacherName: (x.teacher_name as string) ?? null,
            }))
            .filter((label): label is string => label !== null),
        // 카드 단추 줄 (23-14) — 서는지·낱말은 서버 한 곳. 「스케줄에 N건」의 N 은 위 일정 줄의 「미생성」 수와 같은 셈이다
        cardActions: leadCardActions(stage, { unscheduledAppts: appts.filter((a) => !a.scheduled).length }),
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
    /* §24 중단 지점(W11 · N-87) — **실패 당시 단계**가 곧 분류다(원문 슬라이드 24 「fail.from 필드로 중단 단계 판정 · 없으면 at{} 기록을 역순으로」).
       되살릴 단계와 같은 판정(명시값 → 도달 기록 역순)이라 그 결과를 그대로 읽는다 — 판정 없는 옛 행은 미분류(대응표 이관 없음) */
    for (const dto of leads) {
      if (dto.stage !== 'failed') continue;
      const stop = intakeFailStop(dto.revivalStage);
      dto.failStopKey = stop.key;
      dto.failStopLabel = stop.label;
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
    const grade = dto.grade?.trim() || null;
    // 접수는 칸 셋을 언제나 적는다 — 안 보낸 칸도 null(옛 건과 같은 모양 · N-25)
    const sent = leadParentFields(dto);
    const parent = { parentRelation: sent.parentRelation ?? null, parentPhone: sent.parentPhone ?? null, want: sent.want ?? null };
    const id = await this.lead.manager.transaction(async (em) => {
      const [made] = (await em.query(
        `INSERT INTO lead (name, school, owner_id, stage, source, grade, parent_relation, parent_phone, want)
         VALUES ($1, $2, $3, 'first', $4, $5, $6, $7, $8) RETURNING id`,
        [name, dto.school?.trim() || null, owner?.id ?? null, dto.source, grade, parent.parentRelation, parent.parentPhone, parent.want],
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
        [viewerId, lid, JSON.stringify({ name, school: dto.school?.trim() || null, ownerId: owner?.id ?? null, source: dto.source, grade, ...leadParentAudit(parent) })],
      );
      return lid;
    });
    return this.leadOne(id);
  }

  /** 카드 머리 수정 — nullable 칸은 명시한 null/빈 문자열만 비우고, 생략한 칸은 그대로 둔다. */
  async patchLead(viewerId: number, id: number, dto: LeadPatchDto): Promise<LeadDto> {
    const fields = ['name', 'school', 'source', 'ownerId', 'grade', 'parentRelation', 'parentPhone', 'want'] as const;
    if (!fields.some((key) => dto[key] !== undefined)) {
      throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 값을 하나 이상 보내야 합니다' });
    }
    const name = dto.name === undefined ? undefined : dto.name.trim();
    if (name !== undefined && !name) {
      throw new ConflictException({ code: 'LEAD_NAME_REQUIRED', message: '이름을 적어 주세요' });
    }
    // 보낸 칸만 판정한다 — 안 보낸 칸은 앞 값 그대로(undefined)
    const parent = leadParentFields(dto);
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(
        `SELECT id, name, school, source, owner_id, grade, parent_relation, parent_phone, want FROM lead WHERE id=$1 FOR UPDATE`, [id],
      )) as R[];
      if (!cur) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
      let owner: { id: number; name: string } | null = null;
      if (dto.ownerId != null) {
        // FOR KEY SHARE 는 active 만 고치는 비활성화 UPDATE 와 충돌하지 않았다 — 같은 한 함수(FOR SHARE)로 (CR-BE-04)
        owner = await lockActiveStaff(em, dto.ownerId);
        if (!owner) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
      }
      const before = {
        name: String(cur.name), school: (cur.school as string) ?? null, source: (cur.source as string) ?? null,
        ownerId: cur.owner_id == null ? null : Number(cur.owner_id), grade: (cur.grade as string) ?? null,
        parentRelation: (cur.parent_relation as string) ?? null, parentPhone: (cur.parent_phone as string) ?? null,
        want: (cur.want as string) ?? null,
      };
      const after = {
        name: name ?? before.name,
        school: dto.school === undefined ? before.school : dto.school?.trim() || null,
        source: dto.source ?? before.source,
        ownerId: dto.ownerId === undefined ? before.ownerId : owner?.id ?? null,
        grade: dto.grade === undefined ? before.grade : dto.grade?.trim() || null,
        parentRelation: parent.parentRelation === undefined ? before.parentRelation : parent.parentRelation,
        parentPhone: parent.parentPhone === undefined ? before.parentPhone : parent.parentPhone,
        want: parent.want === undefined ? before.want : parent.want,
      };
      await em.query(
        `UPDATE lead SET name=$2, school=$3, source=$4, owner_id=$5, grade=$6, parent_relation=$7, parent_phone=$8, want=$9 WHERE id=$1`,
        [id, after.name, after.school, after.source, after.ownerId, after.grade, after.parentRelation, after.parentPhone, after.want],
      );
      // 감사 줄에는 가린 번호만 — 보호자 LOG 와 같은 규약 (연락처는 관리 응답에만)
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'edit',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ ...before, ...leadParentAudit(before) }), JSON.stringify({ ...after, ...leadParentAudit(after) })],
      );
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
      // 재확인 날짜는 그 보류 한 번의 것이다 — 단계가 바뀌면 비운다(다음 보류에 옛 날짜가 남지 않게 · 23-16)
      await em.query(`UPDATE lead SET stage = $2, recheck_on = NULL WHERE id = $1`, [id, dto.to]);
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, $2, $3)`, [id, dto.to, viewerId]);
    });
    return this.leadOne(id);
  }

  /** 접촉 원장의 공용 쓰기 — 독립 접촉과 실패+재연락이 같은 kind/note/nextOn 계약을 쓴다. */
  private static assertLeadTouch(dto: LeadTouchWriteDto): string {
    const note = dto.note.trim();
    if (!note) throw new ConflictException({ code: 'LEAD_TOUCH_NOTE_REQUIRED', message: '한 줄을 적어 주세요' });
    if (!(LEAD_TOUCH_KINDS as readonly string[]).includes(dto.kind)) {
      throw new ConflictException({ code: 'LEAD_TOUCH_KIND_INVALID', message: '접촉 방법은 전화 · 카카오톡 · 문자 · 방문 · 상담 예약 · 예약 불참 · 메모 중 하나입니다' });
    }
    return note;
  }

  private async insertLeadTouch(
    em: EntityManager,
    viewerId: number,
    id: number,
    dto: LeadTouchWriteDto,
  ): Promise<void> {
    const note = OpsService.assertLeadTouch(dto);
    await em.query(
      `INSERT INTO lead_touch (lead_id, kind, note, next_on, by_id) VALUES ($1, $2, $3, $4::date, $5)`,
      [id, dto.kind, note, dto.nextOn ?? null, viewerId],
    );
  }

  /** 접촉 기록 (N-44) — append-only. 끝난 건에도 적을 수 있다(등록 뒤 해피콜 · 실패 뒤 재연락이 사후 관리다) */
  async addLeadTouch(viewerId: number, id: number, dto: LeadTouchWriteDto): Promise<LeadDto> {
    // 기존 오류 순서도 계약이다 — 입력 오류를 먼저 말하고, 유효한 입력일 때만 상담 건 존재를 본다.
    OpsService.assertLeadTouch(dto);
    const [row] = await this.q(`SELECT id FROM lead WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    await this.insertLeadTouch(this.lead.manager, viewerId, id, dto);
    return this.leadOne(id);
  }

  /* ══ 상담 실패 이력 (v2 §24 · N-25 채택 §4-17 · C35) — 판정·기록은 서버 한 곳 ══ */

  /**
   * 실패 전이 — 이전 단계를 **그 순간의 사실**로 fail_from 에 명시 기록하고
   * 도달 기록(append-only)에 'failed' 를 남긴다. 등록 건은 실패로 보낼 수 없다.
   *
   * W11 · N-87 — 그 단계가 곧 §24 중단 지점이다(중단 지점을 묻지 않는다 · 옛 `stop_at` 은 읽기 전용이라 쓰지 않는다).
   * PB-12-1 — 건을 **잠그고 읽어** 판정하고 **그 단계일 때만** 쓴다. 잠그지 않고 읽으면 그사이 커밋된 등록 확정
   * (`EnrollService.enroll` 도 이 행을 잠근다)을 풀린 뒤의 UPDATE 가 실패로 덮는다(test/lead-fail-race-db.spec.ts).
   */
  async failLead(byId: number, id: number, dto: LeadFailDto): Promise<LeadDto> {
    // 사유 분류는 DTO 가 막고 표의 CHECK 가 마지막으로 막는다 — 서비스도 한 번 더 본다(직접 호출 경로 · 24-05)
    if (dto.reasonKind !== undefined && !(LEAD_REASON_KINDS as readonly string[]).includes(dto.reasonKind)) {
      throw new ConflictException({ code: 'LEAD_REASON_KIND_INVALID', message: '사유 분류는 연락 두절 · 타 학원 등록 · 일정 안 맞음 · 비용 · 시기 안 맞음 중 하나입니다' });
    }
    await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(`SELECT id, stage FROM lead WHERE id = $1 FOR UPDATE`, [id])) as Array<{ id: string; stage: string }>;
      if (!row) throw new NotFoundException('상담 건을 찾을 수 없습니다');
      const stage = String(row.stage);
      if (stage === 'failed') throw new ConflictException({ code: 'ALREADY_FAILED', message: '이미 실패로 분류된 건입니다' });
      if (stage === 'enrolled') throw new ConflictException({ code: 'ENROLLED_LOCKED', message: '등록된 건은 실패로 보낼 수 없습니다' });
      const written = writtenRows(await em.query(
        `UPDATE lead SET stage = 'failed', fail_from = $2, reason = COALESCE($3, reason),
                         reason_kind = COALESCE($4, reason_kind) WHERE id = $1 AND stage = $2 RETURNING id`,
        [id, stage, dto.reason?.trim() || null, dto.reasonKind ?? null]));
      if (!written.length) throw new ConflictException({ code: 'LEAD_STAGE_CHANGED', message: '그사이 단계가 바뀌었습니다 — 다시 불러와 주세요' });
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'failed', $2)`, [id, byId]);
      if (dto.nextOn != null) {
        await this.insertLeadTouch(em, byId, id, {
          kind: 'memo', note: '등록 실패 후 재연락 예정', nextOn: dto.nextOn,
        });
      }
    });
    return this.leadOne(id);
  }

  /**
   * 되살리기 — 대상 단계는 지정값 → fail_from 명시값 → 도달 기록 역순. 셋 다 없으면
   * 미분류 그대로 두고 UNCLASSIFIED 로 거절한다 (추정 이관 금지 — 레거시 stop_at 을 쓰지 않는다).
   * 옛 `stop_at` 은 읽기 전용 기록이라 지우지 않는다(W11 · N-87).
   * PB-12-1 — 실패와 같다: 건을 잠그고 실패인지 다시 보고 **실패일 때만** 쓴다. 「바로 수업 등록」이 먼저 커밋되면 NOT_FAILED 다.
   */
  async resumeLead(byId: number, id: number, dto: { to?: string }): Promise<LeadDto> {
    await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(
        `SELECT id, stage, fail_from FROM lead WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; stage: string; fail_from: string | null }>;
      if (!row) throw new NotFoundException('상담 건을 찾을 수 없습니다');
      if (String(row.stage) !== 'failed') {
        throw new ConflictException({ code: 'NOT_FAILED', message: '실패 상태의 건만 되살릴 수 있습니다' });
      }
      let target: string | null = dto.to ?? (row.fail_from ?? null);
      if (!target) {
        const [g] = (await em.query(
          `SELECT stage FROM lead_stage_log WHERE lead_id = $1 AND stage <> 'failed' ORDER BY id DESC LIMIT 1`, [id],
        )) as Array<{ stage: string }>;
        target = g ? String(g.stage) : null;
      }
      if (!target) {
        throw new ConflictException({
          code: 'UNCLASSIFIED',
          message: '이력이 없어 되살릴 단계를 판정할 수 없습니다 — 단계를 지정해 주세요 (레거시 건은 추정하지 않습니다)',
        });
      }
      const written = writtenRows(await em.query(
        `UPDATE lead SET stage = $2, fail_from = NULL, recheck_on = NULL WHERE id = $1 AND stage = 'failed' RETURNING id`, [id, target],
      ));
      if (!written.length) throw new ConflictException({ code: 'NOT_FAILED', message: '실패 상태의 건만 되살릴 수 있습니다' });
      await em.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, $2, $3)`, [id, target, byId]);
    });
    return this.leadOne(id);
  }

  /** 상담 한 줄 — 쓰기 응답이 `GET /ops` 와 같은 모양을 쓴다(배치안·일정 컨트롤러도 이것으로 답한다 · 23-15 · 23-16) */
  async leadOne(id: number, canSeeAmounts = false): Promise<LeadDto> {
    const [row] = await this.leadRows('WHERE l.id = $1', [id], todayKst(), canSeeAmounts);
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
    /* W11 · N-29 ③ — 「보류」로 답한 코멘트. 보류는 카드를 풀지 않는다(고친 것은 `answered` 만 · 칩은 원문 둘 그대로) */
    const heldOn = new Map<number, Set<number>>();

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
        heldOn.set(mktId, new Set());
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
      else if (r.parent_id != null) (kind === 'hold' ? heldOn : answered).get(mktId)?.add(leadId(r.parent_id));
    }

    // 「고쳤습니다 / 확인 필요」는 **가장 나중 코멘트에 「고친 것 알리기」 답이 달렸는가** 하나로 정한다.
    // 시각 비교로 만들면 칩과 머리의 숫자가 갈린다 (D-R39). 보류는 답이지만 고친 것이 아니다(N-29 ③ — 「확인 필요」로 남는다).
    const threads = [...byMkt.values()];
    for (const t of threads) {
      const last = lastComment.get(t.mktId);
      const done = last ? (answered.get(t.mktId)?.has(last.id) ?? false) : true;
      t.state = done ? 'fixed' : 'needs_fix';
      t.stateLabel = mfbStateLabel(t.state);
      t.held = !done && !!last && (heldOn.get(t.mktId)?.has(last.id) ?? false);
      if (last) t.at = last.at;
    }
    /* 차례는 **최근 코멘트가 위**다 — 원문 §60 컷은 「고쳤습니다」(21:15)가 「확인 필요」(21:10) 위에 선다 (g6 60-1 · x5).
       상태로 먼저 가르지 않는다 — 고쳐야 할 것은 머리 띠의 「고쳐야 할 것 N건」과 카드 칩이 말한다. */
    threads.sort((a, b) => b.at.localeCompare(a.at));
    return threads;
  }

  /**
   * 대표 코멘트 — 원문 §60 「대표가 코멘트를 남기면 **관리자 전원**에게 알림이 갑니다」.
   * 알림 대상은 규칙 그대로 관리자 전원이며, 쓴 본인은 뺀다.
   */
  async comment(viewerId: number, canComment: boolean, mktId: number, dto: MfbCommentWriteDto): Promise<MfbThreadDto[]> {
    if (!canComment) {
      throw new ConflictException({ code: 'CEO_ONLY', message: '대표 코멘트는 대표만 남깁니다' });
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
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT id, $1, $2, '/ops?tab=mkt', 'request', $3 FROM staff WHERE role <> 'teacher' AND id <> $1`,
        [viewerId, `대표 피드백 — ${name}`, NOTI_TITLE.mktFeedback],
      );
    });
    return this.feedbackThreads(viewerId);
  }

  /**
   * 담당자 답변 — 원문 §60 「담당자 답변은 **대표에게만**」.
   * 코멘트를 쓴 대표 한 사람에게만 간다. 전원 공지는 대표 코멘트 쪽 규칙이다.
   *
   * W11 · N-29 ③ — 답은 두 갈래다: 「고친 것 알리기」(reply · 카드를 푼다) · 「보류」(hold · 카드는 「확인 필요」로 남는다).
   * 보류는 코멘트마다 한 번이고, 이미 고친 것을 알린 코멘트에는 보류가 없다. 코멘트 한 줄을 잠그고 그 아래 답을 다시 본다
   * — 두 창에서 동시에 눌러도 판정이 갈리지 않는다(`mfb_hold_once` 유일 색인이 마지막으로 막는다).
   */
  async reply(viewerId: number, mktId: number, dto: MfbReplyWriteDto): Promise<MfbThreadDto[]> {
    const kind = dto.kind ?? 'reply';
    if (!(MFB_ANSWER_KINDS as readonly string[]).includes(kind)) {
      throw new ConflictException({ code: 'MFB_KIND_INVALID', message: '답은 고친 것 알리기 · 보류 중 하나입니다' });
    }
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
      await em.query(`SELECT id FROM mfb WHERE id = $1 FOR UPDATE`, [dto.parentId]);
      if (kind === 'hold') {
        const [seen] = (await em.query(
          `SELECT count(*) FILTER (WHERE kind = 'reply')::int AS fixed, count(*) FILTER (WHERE kind = 'hold')::int AS held
             FROM mfb WHERE parent_id = $1`,
          [dto.parentId],
        )) as Array<{ fixed: number; held: number }>;
        if (Number(seen?.fixed ?? 0) > 0) {
          throw new ConflictException({ code: 'MFB_ALREADY_FIXED', message: '이미 고친 것을 알린 코멘트입니다' });
        }
        if (Number(seen?.held ?? 0) > 0) {
          throw new ConflictException({ code: 'MFB_ALREADY_HELD', message: '이미 보류한 코멘트입니다 — 고친 뒤 「고친 것 알리기」로 답해 주세요' });
        }
      }
      await em.query(
        `INSERT INTO mfb (mkt_id, by_id, body, kind, parent_id) VALUES ($1, $2, $3, $4, $5)`,
        [mktId, viewerId, dto.body.trim(), kind, dto.parentId],
      );
      const to = leadId(parent.by_id);
      if (to !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, '/ops?tab=mkt', 'request', $4)`,
          [to, viewerId, `${kind === 'hold' ? '피드백 보류' : '피드백 답변'} — ${name}`, NOTI_TITLE.mktReply],
        );
      }
    });
    return this.feedbackThreads(viewerId);
  }

  /**
   * 답 고치기 — 원문 §60 「답 고치기」. **자기가 쓴 글만** 고친다.
   *
   * **고치기 전의 말이 안 남던 자리다** (S7 · 전수 검수 §7). 하는 일은 `mfb.body` 한 칸 덮어쓰기라
   * 대표 코멘트든 담당자 답변이든 **원래 무엇이라 적었는지가 그 자리에서 사라졌다.** §60 은 그 글로
   * 「고쳐야 할 것 N건」을 세고 답변이 코멘트에 걸리는 화면이라, 앞말이 바뀌면 뒷말의 뜻도 바뀐다.
   *
   * 지난 글은 되살리지 않는다 — 고친 글이 지금의 참이다. 다만 **무엇이 무엇으로 바뀌었는지**는
   * `log` 에 남는다(append-only). 판정을 잠금 안에서 다시 보는 것은 두 창에서 동시에 고칠 때
   * 마지막 글과 원장의 before 가 어긋나지 않게 하기 위해서다.
   */
  async editPost(viewerId: number, postId: number, dto: MfbEditDto): Promise<MfbThreadDto[]> {
    const body = dto.body.trim();
    await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(`SELECT id, by_id, body FROM mfb WHERE id = $1 FOR UPDATE`, [postId])) as R[];
      if (!row) throw new NotFoundException('글이 없습니다');
      if (leadId(row.by_id) !== viewerId) {
        throw new ConflictException({ code: 'NOT_AUTHOR', message: '자기가 쓴 글만 고칠 수 있습니다' });
      }
      await em.query(`UPDATE mfb SET body = $2 WHERE id = $1`, [postId, body]);
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'MFB',$2,'edit',$3::jsonb,$4::jsonb)`,
        [viewerId, postId, JSON.stringify({ body: row.body ?? null }), JSON.stringify({ body })],
      );
    });
    return this.feedbackThreads(viewerId);
  }

  /* ══ §62 기획 기한 · §65 기획 보고서 (C56) ═══════════════════════════ */

  /**
   * 원문 §62 는 **기획 마감과 과제 기한을 한 표에** 날짜 순으로 섞는다.
   *
   * 두 표(PLAN · TODO)에서 오지만 화면은 한 줄씩만 본다 — 「남은 날」 낱말도 「기한 지난 것 N건」도
   * 서버가 만든다. 화면이 날짜를 빼기 시작하면 머리의 숫자와 줄의 색이 갈린다 (D-R37).
   */
  private async planDeadlines(
    today: string, viewerId: number, canApprovePlan: boolean,
  ): Promise<{ planDues: PlanDueRowDto[]; planOverdue: number }> {
    /* N-72 — 기한 표도 보이는 기획의 줄만 싣는다. 과제 줄은 **그 기획이 보일 때만** 선다(과제 제목도 기획의 일부다)
       N-95 — 반려된 기한도 표에 선다: 원문 §62 첫 줄 「08-19 · D-2 · 기획 마감」이 §61 「보완 요청」 카드의 반려된 날짜다
       (W11 재대조). 붉게 칠하고 「기한 지난 것」으로 세는 판정은 §61 카드처럼 **지금 기한만** 본다 — 반려된 날짜는 더 이상 마감이 아니다. */
    const visible = planCanSql('p', '$2', '$3');
    const rows = await this.q(
      `SELECT 'plan' AS kind, p.id AS ref_id, p.id AS plan_id, p.title AS title, p.title AS plan_title,
              to_char(COALESCE(p.due_on, p.due_rejected_on),'YYYY-MM-DD') AS due_on, p.stage, o.name AS owner_name,
              (p.due_on IS NULL) AS rejected
         FROM plan p LEFT JOIN staff o ON o.id = p.owner_id
        WHERE COALESCE(p.due_on, p.due_rejected_on) IS NOT NULL AND p.stage = ANY($1::text[]) AND ${visible}
       UNION ALL
       SELECT 'task', t.id, p.id, t.title, p.title,
              to_char(t.due_on,'YYYY-MM-DD'), p.stage, o.name, false
         FROM todo t
         JOIN plan p ON p.id = t.plan_id
         LEFT JOIN staff o ON o.id = t.to_id
        WHERE t.due_on IS NOT NULL AND NOT t.done AND ${visible}
        ORDER BY 6, 2`,
      [[...PLAN_OPEN_STAGES], viewerId, canApprovePlan],
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
        overdueDays: r.rejected === true ? 0 : Math.max(0, -left),
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
      `SELECT p.id, p.title, p.stage, p.goal, p.research, p.ask, p.owner_id, p.rework_reason,
              to_char(p.due_on,'YYYY-MM-DD') AS due_on, p.due_approved_at,
              to_char(p.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS created_on,
              o.name AS owner_name, a.name AS due_by_name,
              -- W11 · N-72 공개 범위와 지정된 사람 · N-95 반려된 기한(누가)
              p.share,
              COALESCE((SELECT array_agg(pp.staff_id ORDER BY pp.staff_id) FROM plan_pick pp WHERE pp.plan_id = p.id), '{}') AS pick_ids,
              COALESCE((SELECT array_agg(st.name ORDER BY pp.staff_id) FROM plan_pick pp JOIN staff st ON st.id = pp.staff_id
                         WHERE pp.plan_id = p.id), '{}') AS pick_names,
              to_char(p.due_rejected_on,'YYYY-MM-DD') AS due_rejected_on, rj.name AS due_rejected_by_name,
              ${planCanSql('p', '$2', '$3')} AS visible
         FROM plan p
         LEFT JOIN staff o ON o.id = p.owner_id
         LEFT JOIN staff a ON a.id = p.due_approved_by
         LEFT JOIN staff rj ON rj.id = p.due_rejected_by
        WHERE p.id = $1`,
      [id, viewerId, canApprove],
    );
    // 보이지 않는 기획은 없는 것과 같다 — 목록에서 빠진 기획을 주소로 열 수 있으면 「지정 공개」가 거짓이 된다 (N-72)
    if (!p || p.visible !== true) return null;

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
    const rejectedOn = (p.due_rejected_on as string) ?? null;
    const stage = String(p.stage);
    const open = PLAN_OPEN_STAGES.includes(stage);

    /* 원문 §61·§65: 「대표는 **기한을 먼저 승인해야** 최종 승인이 열립니다」.
       판정은 `planGates` 한 곳이고 쓰기(`decidePlanDue`·`reviewPlan`)가 **잠근 행으로** 같은 함수를 부른다 (PB-12-2).
       막힌 이유까지 서버가 문장으로 내려보낸다 — 화면이 역할과 기한 상태를 다시 조합하면 단추와 서버가 갈린다 (D-R39). */
    const { dueState, canDecideDue, reworkBlockedReason, reviewBlockedReason } = OpsService.planGates(
      { stage, owner_id: p.owner_id, due_on: due, due_approved_at: p.due_approved_at, due_rejected_on: rejectedOn },
      canApprove, viewerId,
    );

    /* 고칠 수 있는지도 **쓰기와 같은 집합**을 본다 — 막힌 문장은 `PATCH` 가 409 로 내는 그 문장이다 */
    const canEdit = PLAN_WRITABLE_STAGES.includes(stage);
    const share = (p.share as string) ?? null;

    return {
      id: leadId(p.id), title: String(p.title), stage, stageLabel: planStageLabel(stage),
      ownerId: leadId(p.owner_id, true), ownerName: (p.owner_name as string) ?? null,
      canChangeOwner: canApprove, createdOn: String(p.created_on),
      goal: (p.goal as string) ?? null,
      tasks, taskDone: tasks.filter((t) => t.done).length,
      research: (p.research as string) ?? null, ask: (p.ask as string) ?? null,
      dueOn: due, dueState, dueStateLabel: PLAN_DUE_STATE_LABEL[dueState as PlanDueState],
      dueApprovedByName: (p.due_by_name as string) ?? null,
      // N-95 — 반려된 기한과 반려한 사람 (옛 반려는 기록이 없어 null · N-25)
      dueRejectedOn: rejectedOn,
      dueRejectedByName: rejectedOn ? ((p.due_rejected_by_name as string) ?? null) : null,
      overdueDays: open && due && due < today ? daysSince(due) : 0,
      canDecideDue, canReview: reviewBlockedReason === null, reviewBlockedReason,
      canRework: reworkBlockedReason === null, reworkBlockedReason,
      reworkReason: (p.rework_reason as string) ?? null,
      canEdit, editBlockedReason: canEdit ? null : planLockedMessage(stage),
      nextStages: planNextStages(stage).map((key) => ({ key, label: PLAN_STAGE_LABEL[key] })),
      // 「+ 대표 지시」 — 쓰기(`addPlanTask`)와 같은 함수가 판정한다 (w5 · 65-4 · S5)
      canAddTask: planTaskBlockedReason(stage, canApprove) === null,
      addTaskBlockedReason: planTaskBlockedReason(stage, canApprove),
      // N-72 — 공개 범위 · 지정된 사람. 옛 기획(NULL)은 칩이 없다. 고르는 칸은 단계와 무관하게 선다(누가 보는가는 본문이 아니다)
      share, shareLabel: planShareLabel(share),
      pickIds: ((p.pick_ids ?? []) as unknown[]).map((v) => leadId(v)),
      pickNames: ((p.pick_names ?? []) as unknown[]).map((v) => String(v)),
      canEditShare: OpsService.canEditPlanShare(p.owner_id, viewerId, canApprove),
    };
  }

  /**
   * 공개 범위를 바꿀 수 있는가 (N-72) — **담당 · 결재권자**. 지정된 사람은 볼 수만 있다 —
   * 볼 수 있다고 누구에게 보일지까지 정하면 지정 공개가 한 사람의 선택으로 풀린다. 읽기(canEditShare)와 쓰기가 같은 함수다.
   */
  private static canEditPlanShare(ownerId: unknown, viewerId: number, canApprove: boolean): boolean {
    return canApprove || (ownerId != null && Number(ownerId) === viewerId);
  }

  /**
   * 「+ 대표 지시」 — 원본 §65 「2 · 과제」 오른쪽 단추 (w5 · g6 65-4).
   *
   * 과제는 **TODO 한 줄**(`src='plan'` · `plan_id`)이다 — §62 기한 표·§65 과제 줄·§61 「과제 1/3」·§64 할 일이
   * 전부 그 한 줄을 읽는다(새 표를 파지 않는다 · D-R22). 담당 알림·감사 줄이 **같은 트랜잭션**이다 —
   * 밖에서 알리면 할 일은 안 생겼는데 알림만 간다(§66 할 일 배정과 같은 규약 · D-R43).
   * 기획 행을 잠근 채 단계를 다시 본다 — 그 사이 완료로 옮겨진 기획에 과제가 붙지 않게.
   */
  async addPlanTask(viewerId: number, canApprove: boolean, id: number, dto: PlanTaskCreateDto): Promise<PlanDetailDto> {
    const title = dto.title.trim();
    await this.lead.manager.transaction(async (em) => {
      // 잠근 채 읽는다 — 보이지 않는 기획(N-72)은 없는 것과 같다
      const cur = await this.lockPlan(em, id, viewerId, canApprove);
      const blocked = planTaskBlockedReason(cur.stage, canApprove);
      if (blocked) throw new ConflictException({ code: canApprove ? 'PLAN_DONE' : 'CEO_ONLY', message: blocked });
      if (!title) throw new ConflictException({ code: 'TASK_TITLE_REQUIRED', message: '할 일을 적어 주세요' });
      // 그만둔 사람에게는 주지 않는다 — 이 파일의 다른 담당 자리와 같은 판정(S4)
      const [to] = (await em.query(`SELECT id, name FROM staff WHERE id = $1 AND active`, [dto.toId])) as Array<{ id: string }>;
      if (!to) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
      await em.query(
        `INSERT INTO todo (title, from_id, to_id, due_on, done, src, plan_id)
         VALUES ($1, $2, $3, $4::date, false, 'plan', $5)`,
        [title, viewerId, dto.toId, dto.dueOn ?? null, id],
      );
      if (dto.toId !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, $4, 'request', $5)`,
          [dto.toId, viewerId, `기획 과제 — ${cur.title} · ${title}${dto.dueOn ? ` · 기한 ${dto.dueOn.slice(5)}` : ''}`, `/ops?tab=plan&plan=${id}`, NOTI_TITLE.planTask],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'plan',$2,'task',$3::jsonb)`,
        [viewerId, id, JSON.stringify({ title, toId: dto.toId, dueOn: dto.dueOn ?? null })],
      );
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /**
   * 기한 승인 · 반려 — 원문 §65 의 띠 안 단추 둘.
   *
   * 반려는 **기한을 지운다.** 담당자가 새 날짜를 다시 내야 하기 때문이다. 지운 날짜는 반려 칸에 남아(N-95)
   * §61 카드와 §62 표에 원문대로 서되, 지금 기한이 아니라서 지난 기한으로 세지 않는다(W11 재대조).
   */
  async decidePlanDue(viewerId: number, canApprove: boolean, id: number, dto: PlanDueDecisionDto): Promise<PlanDetailDto> {
    if (!canApprove) {
      throw new ConflictException({ code: 'CEO_ONLY', message: '기한 승인은 대표만 합니다' });
    }
    /*
     * PB-12-2 — **잠근 행으로 판정하고, 기대 상태를 조건으로 쓴다.** 전에는 잠그지 않고 읽은 뒤 트랜잭션에서 무조건
     * 승인했다: 그 사이 담당이 기한을 옮기면(patchPlan 은 잠근다) 대표가 본 적 없는 날짜가 승인되고 감사 줄에는
     * 옛 날짜가 적혔다. 이제 담당의 쓰기가 끝날 때까지 기다린 뒤 **지금 날짜**를 보고, 대표가 본 날짜와 다르면 돌려보낸다.
     */
    await this.lead.manager.transaction(async (em) => {
      const row = await this.lockPlan(em, id, viewerId, canApprove);
      // 올린 사람은 자기 기한을 스스로 승인하지 못한다 — `createPlan` 이 담당 기본값을 호출자로 박으므로
      // 이 검사가 없으면 「올리고 내가 승인」이 한 사람 안에서 닫힌다 (2026-09-20 검수)
      if (blocksSelfApproval('plan-due', row.owner_id, viewerId)) {
        throw new ConflictException({
          code: SELF_APPROVAL_CODE,
          message: '자기가 담당인 기획의 기한은 자기가 승인할 수 없습니다 — 내는 사람과 승인하는 사람은 다릅니다',
        });
      }
      if (!row.due_on) {
        throw new ConflictException({ code: 'NO_DUE', message: '제안된 기한이 없습니다' });
      }
      if (row.due_on !== dto.dueOn) {
        // 대표가 본 날짜가 아니면 승인도 반려도 하지 않는다 — 옮겨졌으면 다시 보고 정한다
        throw new ConflictException({ code: 'PLAN_DUE_CHANGED', message: planDueChangedMessage(row.due_on) });
      }
      if (row.due_approved_at) {
        throw new ConflictException({ code: 'DUE_ALREADY_APPROVED', message: '이미 승인된 기한입니다' });
      }

      const beforeDue = { dueOn: row.due_on, approvedAt: null };
      /* 기대 상태 조건으로 쓴다 — 잠근 행이라 어긋날 수 없지만, 조건이 곧 이 쓰기의 뜻이다 (날짜 · 미승인) */
      const where = `WHERE id = $1 AND due_on = $2::date AND due_approved_at IS NULL`;
      if (dto.approve) {
        await em.query(`UPDATE plan SET due_approved_at = now(), due_approved_by = $3 ${where}`, [id, dto.dueOn, viewerId]);
      } else {
        /* N-95 — 반려는 날짜를 지우고 **무엇을 언제 누가** 반려했는지 남긴다. 카드가 「D-2 08-19 · 기한 반려」를 세운다 */
        await em.query(
          `UPDATE plan SET due_on = NULL, due_approved_at = NULL, due_approved_by = NULL,
                           due_rejected_on = $2::date, due_rejected_at = now(), due_rejected_by = $3 ${where}`,
          [id, dto.dueOn, viewerId],
        );
      }
      // 반려는 날짜를 지우는 파괴적 쓰기다 — 흔적이 없으면 무엇이 지워졌는지 아무도 모른다. 적는 날짜는 **결정한 그 날짜**다
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'plan', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, id, dto.approve ? 'due_approve' : 'due_reject',
          JSON.stringify(beforeDue),
          JSON.stringify(dto.approve ? { dueOn: dto.dueOn, approvedBy: viewerId } : { dueOn: null, rejectedOn: dto.dueOn })],
      );
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /** 최종 승인 · 보완 요청 — **기한이 먼저 승인돼야 열린다** (원문 §61·§65) */
  async reviewPlan(viewerId: number, canApprove: boolean, id: number, dto: PlanReviewDto): Promise<PlanDetailDto> {
    const next = dto.decision === 'approve' ? 'approved' : 'rework';
    const reason = dto.reason?.trim() || null;
    /*
     * PB-12-2 — 판정도 쓰기도 **잠근 행 하나로** 한다. 전에는 판정을 트랜잭션 밖에서 하고 `UPDATE … WHERE id` 로
     * 무조건 썼다 — 두 결재자가 동시에 누르면 마지막 쓰기가 이겼고(먼저 커밋된 보완 요청이 승인에 덮였다) 감사 줄은 둘 다 남았다.
     */
    await this.lead.manager.transaction(async (em) => {
      const row = await this.lockPlan(em, id, viewerId, canApprove);
      // 기한과 같은 규칙 — 올린 사람은 최종 승인도 하지 못한다
      if (blocksSelfApproval('plan', row.owner_id, viewerId)) {
        throw new ConflictException({
          code: SELF_APPROVAL_CODE,
          message: '자기가 담당인 기획은 자기가 결재할 수 없습니다 — 내는 사람과 결재하는 사람은 다릅니다',
        });
      }
      /* 결정마다 제 문을 본다 — 최종 승인은 기한 승인을 기다리고, 보완 요청은 기다리지 않는다 (g6 65-7 · x5).
         막힌 문장은 읽기(`reviewBlockedReason`·`reworkBlockedReason`)와 같은 함수에서 나온다 (S5 · D-R22). */
      const gate = OpsService.planGates(row, canApprove, viewerId);
      const blocked = dto.decision === 'rework' ? gate.reworkBlockedReason : gate.reviewBlockedReason;
      if (blocked) {
        const onlyDue = dto.decision === 'approve' && gate.reworkBlockedReason === null;
        throw new ConflictException({ code: onlyDue ? 'DUE_NOT_APPROVED' : 'NOT_REVIEWABLE', message: blocked });
      }
      if (dto.decision === 'rework' && !reason) {
        throw new ConflictException({ code: 'REASON_REQUIRED', message: '보완 요청에는 사유가 필요합니다' });
      }
      /* S6 — 사유를 **행에** 남긴다. 그동안 `log` 에만 들어가 담당자가 볼 방법이 없었다.
         승인이면 지운다: 지난 반려 사유가 승인된 기획에 남아 있으면 지금 상태를 속인다.
         기대 상태(검토 요청) 조건으로 쓴다 — 잠근 행이라 어긋날 수 없지만 조건이 곧 이 쓰기의 뜻이다. */
      await em.query(
        `UPDATE plan SET stage = $2, rework_reason = $3 WHERE id = $1 AND stage = 'review'`,
        [id, next, next === 'rework' ? reason : null],
      );
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'plan', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, id, dto.decision,
          JSON.stringify({ stage: row.stage }),
          JSON.stringify({ stage: next, reason })],
      );
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /* ══ S6 — 기획이 결재까지 간다 (전수 검수 §5) ═════════════════════════ */

  /**
   * §65 본문 고치기 — 「1 · 목표」「3 · 리서치」「4 · 결정 요청」과 제목·기한.
   *
   * **`research` 를 쓰는 API 가 이것뿐이다.** 그전에는 읽기와 화면 칸만 있고 `createPlan` 의
   * INSERT 에도 없어 시드 말고는 아무도 채우지 못했다 — §65 「3 · 리서치」가 영원히 「—」였다.
   *
   * **보낸 칸만 고친다**(대표 보고 `PATCH /exec/report` 와 같다) — 안 보낸 칸을 지우면 §65 를
   * 나눠 쓰는 자리에서 남의 줄이 사라진다. 그래서 「비운다」와 「안 보낸다」가 다른 뜻이다:
   * `null` 은 지우고, 없는 키는 그대로 둔다.
   *
   * **잠그는 집합은 `PLAN_WRITABLE_STAGES` 하나**이고 화면의 `canEdit` 도 그것을 본다 (D-R39).
   * 잠근 채 읽고 고친다 — 두 사람이 동시에 올리고 고치면 뒤 사람이 409 다.
   */
  async patchPlan(viewerId: number, canApprove: boolean, id: number, dto: PlanPatchDto): Promise<PlanDetailDto> {
    const title = dto.title?.trim();
    if (dto.title !== undefined && !title) {
      throw new ConflictException({ code: 'PLAN_TITLE_REQUIRED', message: '제목을 적어 주세요' });
    }
    /* 본문(제목·목표·리서치·결정 요청·기한)과 공개 범위(누가 보는가)는 **다른 쓰기**다 — 본문만 단계 잠금을 받는다.
       결재가 끝난 기획이라도 누구에게 보일지는 바꿀 수 있어야 한다(보는 사람은 결재한 글의 일부가 아니다 · N-72). */
    const content = title !== undefined || dto.goal !== undefined || dto.research !== undefined
      || dto.ask !== undefined || dto.dueOn !== undefined;
    const shareSent = dto.share !== undefined || dto.pickIds !== undefined;
    await this.lead.manager.transaction(async (em) => {
      // 잠근 채 읽는다(PB-12-2) — 보이지 않는 기획(N-72)은 없는 것과 같다
      const cur = await this.lockPlan(em, id, viewerId, canApprove);
      // 누가 보는가는 담당 · 결재권자만 정한다 — 쓰기 전에 막는다 (읽기의 canEditShare 와 같은 함수 · N-72)
      if (shareSent && !OpsService.canEditPlanShare(cur.owner_id, viewerId, canApprove)) {
        throw new ForbiddenException({ code: 'PLAN_SHARE_FORBIDDEN', message: '공개 범위는 담당이나 결재권자가 정합니다' });
      }
      if (content && !PLAN_WRITABLE_STAGES.includes(cur.stage)) {
        // 읽기의 editBlockedReason 과 **같은 함수**에서 나온 같은 문장이다 (D-R22 · S5)
        throw new ConflictException({ code: 'PLAN_LOCKED', message: planLockedMessage(cur.stage) });
      }
      /* 승인된 기한을 담당이 옮길 수 있으면 **대표의 승인이 거짓이 된다**. 반려로 지워진 뒤
         새 날짜를 내는 길이 이것이다 — 그전에는 그 길이 아예 없었다. */
      if (dto.dueOn !== undefined && cur.due_approved_at) {
        throw new ConflictException({
          code: 'PLAN_DUE_APPROVED',
          message: '승인된 기한은 바꿀 수 없습니다 — 대표가 기한을 반려한 뒤에 새로 내세요',
        });
      }

      const sets: string[] = [];
      const params: unknown[] = [id];
      const put = (col: string, value: unknown, cast = ''): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (title !== undefined) put('title', title);
      if (dto.goal !== undefined) put('goal', dto.goal?.trim() || null);
      if (dto.research !== undefined) put('research', dto.research?.trim() || null);
      if (dto.ask !== undefined) put('ask', dto.ask?.trim() || null);
      if (dto.dueOn !== undefined) {
        put('due_on', dto.dueOn ?? null, '::date');
        /* N-95 — 담당이 **새 기한을 내면** 반려 표시를 비운다(표의 plan_due_rejected_clears 가 같은 것을 지킨다).
           기한을 비우기만 하면(null) 반려 표시는 그대로다 — 새 기한을 낸 것이 아니다. */
        if (dto.dueOn) sets.push('due_rejected_on = NULL', 'due_rejected_at = NULL', 'due_rejected_by = NULL');
      }

      if (sets.length) {
        await em.query(`UPDATE plan SET ${sets.join(', ')} WHERE id = $1`, params);
        await em.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'plan',$2,'edit',$3::jsonb)`,
          // 무엇을 고쳤는지만 남긴다 — 본문 전체를 감사 줄에 복사하면 같은 글이 두 곳에 산다
          [viewerId, id, JSON.stringify({ fields: [...new Set(sets.map((x) => x.split(' ')[0]).filter((c) => !c.startsWith('due_rejected')))] })],
        );
      }

      if (shareSent) await this.writePlanShare(em, viewerId, cur, dto);
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /** 기획 담당 변경 — 결재권자만, 활동 중인 구성원만. 새 담당 알림과 감사 줄까지 원자적이다. */
  async patchPlanOwner(
    viewerId: number, canApprove: boolean, id: number, dto: PlanOwnerPatchDto,
  ): Promise<PlanDetailDto> {
    if (!canApprove) {
      throw new ForbiddenException({ code: 'PLAN_OWNER_FORBIDDEN', message: '기획 담당은 결재권자만 바꿀 수 있습니다' });
    }
    await this.lead.manager.transaction(async (em) => {
      const cur = await this.lockPlan(em, id, viewerId, canApprove);
      // 기획 잠금 → 담당 잠금(FOR SHARE) 차례 — 비활성화가 먼저 잠갔으면 그 커밋을 기다린 뒤 최신 active 로 판정한다 (CR-BE-04)
      const next = await lockActiveStaff(em, dto.ownerId);
      if (!next) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 담당자를 찾을 수 없습니다' });
      const beforeId = leadId(cur.owner_id, true);
      if (beforeId === dto.ownerId) return;
      await em.query(`UPDATE plan SET owner_id = $2 WHERE id = $1`, [id, dto.ownerId]);
      if (dto.ownerId !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title)
           VALUES ($1,$2,$3,$4,'request',$5)`,
          [dto.ownerId, viewerId, `기획 「${cur.title}」 담당이 됐습니다`, `/ops?tab=plan&plan=${id}`, NOTI_TITLE.planOwner],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1,'plan',$2,'owner',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ ownerId: beforeId }), JSON.stringify({ ownerId: dto.ownerId, ownerName: next.name })],
      );
    });
    return (await this.planDetail(id, canApprove, viewerId))!;
  }

  /** 관리자 건의 답변 — 강사 수신 사실, 알림, 감사 줄이 한 트랜잭션에 남는다. */
  async replySuggestion(viewerId: number, id: number, dto: SuggestionReplyDto): Promise<SuggestionDto> {
    const reply = dto.reply.trim();
    if (!reply) throw new ConflictException({ code: 'SUGGESTION_REPLY_REQUIRED', message: '답변을 적어 주세요' });
    await this.lead.manager.transaction(async (em) => {
      const [cur] = (await em.query(
        `SELECT id, staff_id, reply, reply_by, reply_at FROM suggestion WHERE id = $1 FOR UPDATE`, [id],
      )) as R[];
      if (!cur) throw new NotFoundException({ code: 'SUGGESTION_NOT_FOUND', message: '건의를 찾을 수 없습니다' });
      // TypeORM의 UPDATE ... RETURNING raw 값은 드라이버별로 `[rows, count]`일 수 있다.
      // DB 시계를 먼저 한 번 읽어 화면 사실과 감사 사실에 같은 시각을 쓴다.
      const [clock] = (await em.query(`SELECT now() AS reply_at`)) as R[];
      await em.query(
        `UPDATE suggestion SET state = 'done', reply = $2, reply_by = $3, reply_at = $4 WHERE id = $1`,
        [id, reply, viewerId, clock!.reply_at],
      );
      const teacherId = leadId(cur.staff_id);
      if (teacherId !== viewerId) {
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title)
           VALUES ($1,$2,$3,'/teacher/suggestions','request',$4)`,
          [teacherId, viewerId, `보낸 건의에 관리자가 답변했습니다 — ${reply.slice(0, 80)}`, NOTI_TITLE.suggestionReply],
        );
      }
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1,'SUGGESTION',$2,'reply',$3::jsonb,$4::jsonb)`,
        [viewerId, id,
          JSON.stringify({ reply: cur.reply ?? null, replyBy: leadId(cur.reply_by, true), replyAt: cur.reply_at ?? null }),
          JSON.stringify({ reply, replyBy: viewerId, replyAt: clock!.reply_at, state: 'done' })],
      );
    });
    const [updated] = await this.suggestionRows('WHERE g.id = $1', [id]);
    return updated!;
  }

  /**
   * 공개 범위 바꾸기 (N-72) — **권한 쓰기**라 감사 표(`plan.share`)에 한 줄을 남긴다 (N-73 · 쓰기와 같은 트랜잭션).
   * 지정된 사람은 통째로 갈아 끼운다 — 한 명씩 더하고 빼는 길을 따로 두면 두 벌이 된다. 지정 공개가 아니면 지정이 없다.
   * 옛 기획(NULL)을 NULL 로 되돌리는 길은 없다 — NULL 은 「모른다」이지 고를 수 있는 값이 아니다.
   */
  private async writePlanShare(
    em: EntityManager, viewerId: number, cur: { id: number; share: string | null },
    dto: { share?: string; pickIds?: number[] },
  ): Promise<void> {
    const share = dto.share ?? cur.share;
    if (!share) {
      throw new ConflictException({ code: 'PLAN_SHARE_REQUIRED', message: '공개 범위를 먼저 고르세요 — 전체 공개 또는 지정 공개' });
    }
    const beforeIds = ((await em.query(
      `SELECT staff_id FROM plan_pick WHERE plan_id = $1 ORDER BY staff_id`, [cur.id],
    )) as Array<{ staff_id: string }>).map((r) => Number(r.staff_id));
    // 지정 공개로 두고 사람만 안 보냈으면 지금 지정을 그대로 둔다 — 안 보낸 칸을 지우지 않는다(보낸 칸만 고친다)
    const nextIds = share === 'picked' && dto.pickIds === undefined
      ? beforeIds
      : await this.planPicks(share, dto.pickIds);
    const same = share === cur.share && nextIds.length === beforeIds.length && nextIds.every((v, i) => v === beforeIds[i]);
    if (same) return;
    await em.query(`UPDATE plan SET share = $2 WHERE id = $1`, [cur.id, share]);
    await em.query(`DELETE FROM plan_pick WHERE plan_id = $1`, [cur.id]);
    if (nextIds.length) {
      await em.query(`INSERT INTO plan_pick (plan_id, staff_id) SELECT $1, unnest($2::bigint[])`, [cur.id, nextIds]);
    }
    await audit(em, 'plan.share', {
      actorId: viewerId, entityId: cur.id,
      before: { share: cur.share, pickIds: beforeIds },
      after: { share, pickIds: nextIds },
    });
  }

  /**
   * 단계 이동 — 원문 §61 「기획 결재 — 왼쪽에서 오른쪽으로 올립니다」.
   *
   * **`stage='review'` 로 가는 길이 여기서 처음 생긴다.** 그전에는 stage 쓰기가 `createPlan`
   * (=draft)과 `reviewPlan`(=approved|rework) 둘뿐이라 **API 로 만든 기획은 §69 「결재 대기」에
   * 영영 안 잡혔다**(전수 검수 §5).
   *
   * 전이표는 `PLAN_NEXT_STAGES` 한 벌이고 **결재는 여기 없다** — `review → approved|rework` 를
   * 넣으면 자기 결재 금지(S1)·기한 승인 선행(C56)·사유 필수를 지나지 않는 **두 번째 승인 경로**가
   * 생긴다 (C90 `moveLeadStage` 와 같은 규약).
   *
   * 다시 올릴 때 **보완 요청 사유를 지운다** — 남겨 두면 고쳐서 올린 기획에 지난 반려 사유가
   * 붙어 있다 (C85-a 가 RPT 에서 정한 것과 같다). 잠근 채 판정한다.
   */
  async movePlanStage(viewerId: number, canApprove: boolean, id: number, dto: PlanStageMoveDto): Promise<PlanDetailDto> {
    await this.lead.manager.transaction(async (em) => {
      // 잠근 채 판정한다 — 보이지 않는 기획(N-72)은 없는 것과 같다
      const cur = await this.lockPlan(em, id, viewerId, canApprove);
      const allowed = planNextStages(cur.stage);
      if (!allowed.length) {
        throw new ConflictException({
          code: 'PLAN_STAGE_LOCKED',
          message: cur.stage === 'review'
            ? '올라온 기획입니다 — 대표의 결재가 다음 단계를 정합니다'
            : `${planStageLabel(cur.stage)} 기획은 단계를 옮길 수 없습니다`,
        });
      }
      if (!(allowed as readonly string[]).includes(dto.to)) {
        throw new ConflictException({
          code: 'PLAN_STAGE_INVALID',
          message: `${planStageLabel(cur.stage)}에서는 ${allowed.map((k) => planStageLabel(k)).join(' · ')}(으)로만 옮길 수 있습니다`,
        });
      }
      await em.query(
        /* 검토 요청으로 다시 올라가면 지난 보완 요청 사유는 사라진다.
           **한 파라미터를 대입과 비교에 같이 쓰면** PostgreSQL 이 `inconsistent types deduced
           for parameter` 로 거절한다 (varchar 대입 ↔ text 비교 · S1 에서 배운 자리). `::text` 로 굳힌다. */
        `UPDATE plan
            SET stage = $2::text,
                rework_reason = CASE WHEN $2::text = 'review' THEN NULL ELSE rework_reason END
          WHERE id = $1`,
        [id, dto.to],
      );
      await em.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1,'plan',$2,'stage',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ stage: cur.stage }), JSON.stringify({ stage: dto.to })],
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
   *
   * @param viewer 보는 사람 (N-32 · W11). 이 창은 이제 **참석자 본인**에게도 열린다 — 「안내 보내기」의 알림 링크가
   *   오는 곳이고, 참석 응답을 거기서 한다(참석자면 역할 무관 · 강사 참석자 포함). 운영 권한(`canManage`)이 없고
   *   참석자도 아니면 없는 것과 같다(null → 404). 단추가 서는지(속기록·할 일·안내 · 내 응답)도 여기서 정한다(D-R39).
   *   인자가 없으면(서비스 직접 호출) 거르지 않고 단추를 모두 닫는다 — 모르는 쪽으로 열지 않는다.
   */
  async meetingDetail(id: number, viewer?: { id: number; canManage: boolean }): Promise<MeetingDetailDto | null> {
    const today = todayKst();
    const [m] = await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date,
              m.pre_files, m.minutes, ${kstAt('m.minutes_at')} AS minutes_at, b.name AS minutes_by_name,
              m.ser_id, ${MEETING_START_MIN} AS start_min, ${MEETING_END_MIN} AS end_min, ${MEETING_MODE} AS mode, r.name AS room_name, z.label AS zoom_label,
              (SELECT o.canceled FROM ser_occ o WHERE o.ser_id = m.ser_id AND o.on_date = m.on_date) AS canceled
         FROM mtrec m LEFT JOIN staff b ON b.id = m.minutes_by
         ${MEETING_PLACE_JOINS}
        WHERE m.id = $1`,
      [id],
    );
    if (!m) return null;

    const people = await this.q(
      `SELECT a.staff_id, a.confirmed, s.name, s.title, s.active
         FROM mtattd a JOIN staff s ON s.id = a.staff_id
        WHERE a.mt_id = $1 ORDER BY s.id`,
      [id],
    );
    const attendees = people.map((r) => {
      const state = mtAttendState(r.confirmed as boolean | null);
      return {
        staffId: leadId(r.staff_id), name: String(r.name), title: (r.title as string) ?? null,
        state, stateLabel: MT_ATTEND_LABEL[state],
      };
    });
    const mine = viewer ? attendees.find((a) => a.staffId === viewer.id) ?? null : null;
    // 운영 권한도 없고 참석자도 아니면 없는 것과 같다 — 회의가 있다는 사실도 새지 않게 404 로 읽힌다
    if (viewer && !viewer.canManage && !mine) return null;

    const tasks = (await this.q(
      `SELECT t.id, t.title, t.done, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name, t.to_id, t.from_id
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
        /* 완료 체크가 서는가 — 쓰기(`PATCH /drawer/todos/:id`)와 같은 판정: 전체 권한 · 받은 사람 · 준 사람 (W11 A' 후속).
           참석자로만 여는 강사는 **자기에게 온 할 일만** 체크한다 — 남의 줄은 체크 칸이 잠긴다(눌러서 404 를 받지 않게) */
        canToggle: viewer?.canManage === true
          || (viewer !== undefined && (Number(t.to_id) === viewer.id || Number(t.from_id) === viewer.id)),
      };
    });

    const confirmed = attendees.filter((a) => a.state === 'in').length;
    const files = Array.isArray(m.pre_files) ? (m.pre_files as unknown[]).map((f) => String(f)) : [];
    const mt = String(m.mt_type);
    const canManage = viewer?.canManage === true;
    // 「안내 보내기」 — 받을 사람(활동 중인 참석자 · 보내는 나 제외)이 있어야 선다. 막힌 이유는 쓰기(409)와 같은 문장이다
    const recipients = people.filter((r) => r.active === true && leadId(r.staff_id) !== viewer?.id).length;
    const noticeBlockedReason = !canManage ? null : OpsService.noticeBlockedReason(m.canceled === true, recipients);

    return {
      id: leadId(m.id), mtType: mt, mtTypeLabel: mtTypeLabel(mt),
      title: (m.title as string) ?? null, onDate: (m.on_date as string) ?? null,
      // §66 머리 「18:30–19:30 · … · 6호」 — §63 줄과 같은 조인·같은 낱말 함수 (w5 · 66-2)
      startMin: m.start_min == null ? null : Number(m.start_min),
      endMin: m.end_min == null ? null : Number(m.end_min),
      placeLabel: meetingPlaceLabel(m),
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
      /* W11 · N-32 — 보는 사람에 따라 서는 단추 (D-R39) */
      canEdit: canManage,
      canSendNotice: canManage && noticeBlockedReason === null,
      noticeBlockedReason,
      canRespond: mine !== null,
      myAttend: mine ? { state: mine.state, stateLabel: mine.stateLabel } : null,
    };
  }

  /** 「안내 보내기」가 막히는 이유 — 읽기(단추)와 쓰기(409)가 같은 함수를 쓴다 (S5 · D-R22) */
  private static noticeBlockedReason(canceled: boolean, recipients: number): string | null {
    if (canceled) return '취소된 회의에는 안내를 보내지 않습니다';
    if (recipients === 0) return '안내를 받을 참석자가 없습니다';
    return null;
  }

  /**
   * §66 「안내 보내기」 (N-32 · W11) — **참석자(직원)에게 NOTI 한 건씩**.
   *
   * 본문은 서버가 **사실로만** 조립한다 — 회의 이름 · 일시 · 강의실 또는 줌 계정 · 참가 링크. 지어낸 인사말이 없다.
   * **줌 비밀번호는 넣지 않는다** — 암호화해 둔 값을 알림 본문(평문)으로 옮기면 암호화가 없던 일이 된다(C98 줌 안내와 같은 선례).
   * 보내는 나에게는 보내지 않는다(C38 · C99 규약) · 그만둔 사람에게도 보내지 않는다(S4).
   * 링크는 이 회의 상세다 — 받은 사람이 거기서 「참석 · 불참」을 누른다. 알림 줄들은 한 트랜잭션이다(D-R43).
   */
  async sendMeetingNotice(viewerId: number, id: number): Promise<MeetingNoticeResultDto> {
    const sent = await this.lead.manager.transaction(async (em) => {
      const [m] = (await em.query(
        `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date,
                m.ser_id, ${MEETING_START_MIN} AS start_min, ${MEETING_END_MIN} AS end_min, ${MEETING_MODE} AS mode, r.name AS room_name, z.label AS zoom_label, z.join_url,
                (SELECT o.canceled FROM ser_occ o WHERE o.ser_id = m.ser_id AND o.on_date = m.on_date) AS canceled
           FROM mtrec m
           ${MEETING_PLACE_JOINS}
          WHERE m.id = $1`,
        [id],
      )) as R[];
      if (!m) throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: '회의를 찾을 수 없습니다' });
      const to = (await em.query(
        `SELECT a.staff_id, s.role::text AS role FROM mtattd a JOIN staff s ON s.id = a.staff_id
          WHERE a.mt_id = $1 AND s.active AND a.staff_id <> $2 ORDER BY a.staff_id`,
        [id, viewerId],
      )) as Array<{ staff_id: string; role: string }>;
      const blocked = OpsService.noticeBlockedReason(m.canceled === true, to.length);
      if (blocked) throw new ConflictException({ code: 'MEETING_NOTICE_BLOCKED', message: blocked });

      const name = (m.title as string) ?? mtTypeLabel(String(m.mt_type));
      const when = [
        (m.on_date as string) ?? null,
        m.start_min == null || m.end_min == null ? null : `${OpsService.hm(Number(m.start_min))}–${OpsService.hm(Number(m.end_min))}`,
      ].filter(Boolean).join(' ');
      const place = m.ser_id == null ? null
        : m.mode === 'online'
          ? `온라인${m.zoom_label ? ` · 줌 ${String(m.zoom_label)}` : ''}${m.join_url ? ` · 참가 ${String(m.join_url)}` : ''}`
          : (m.room_name as string) ?? null;
      const body = [name, when || null, place].filter(Boolean).join(' · ');
      // 링크는 받는 사람이 열 수 있는 자리로 — 운영 화면을 못 여는 강사 참석자는 강사 홈의 회의 창(W11 A' 후속 · lib/meeting-link)
      await em.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT t.to_id, $2, $3, t.link, 'schedule', $4 FROM unnest($1::bigint[], $5::text[]) AS t(to_id, link)`,
        [to.map((r) => r.staff_id), viewerId, body, NOTI_TITLE.meetingNotice,
          to.map((r) => meetingNotiLink(r.role, id, `/ops?tab=meeting&meeting=${id}`))],
      );
      return to.length;
    });
    return { sent, meeting: (await this.meetingDetail(id, { id: viewerId, canManage: true }))! };
  }

  /**
   * 참석 응답 (N-32 · W11) — **본인이** 자기 줄만 「참석 · 불참」으로 적는다. 대리 입력은 없다.
   *
   * 참석자면 역할과 무관하다(강사 참석자 포함) — 그래서 경로에 역할 가드가 없고 여기서 「참석자인가」를 본다.
   * 날이 지나도 응답하지 않은 줄은 「응답 대기」 그대로다 — 추정으로 불참을 적지 않는다(N-25).
   */
  async respondMeeting(viewer: { id: number; canManage: boolean }, id: number, confirmed: boolean): Promise<MeetingDetailDto> {
    // 본인 줄 하나만 — 세는 CTE 로 「내 줄이 있었는가」를 같은 문장에서 안다
    const [{ n }] = await this.q<{ n: number }>(
      `WITH u AS (UPDATE mtattd SET confirmed = $3 WHERE mt_id = $1 AND staff_id = $2 RETURNING 1)
       SELECT count(*)::int AS n FROM u`,
      [id, viewer.id, confirmed],
    );
    if (n === 0) {
      const [m] = await this.q(`SELECT id FROM mtrec WHERE id = $1`, [id]);
      // 회의가 없거나, 운영 권한 없이 참석자도 아닌 사람 — 둘 다 없는 것과 같다
      if (!m || !viewer.canManage) throw new NotFoundException({ code: 'MEETING_NOT_FOUND', message: '회의를 찾을 수 없습니다' });
      throw new ForbiddenException({ code: 'MEETING_NOT_ATTENDEE', message: '참석자로 적힌 사람만 응답합니다 — 대신 적지 않습니다' });
    }
    return (await this.meetingDetail(id, viewer))!;
  }

  /**
   * 속기록 저장 — **누가 언제**를 서버가 남긴다.
   *
   * 화면이 보낸 시각을 믿지 않는다. 시계가 틀린 기계에서 저장하면 회의록의 순서가 뒤집힌다.
   * **통째로 덮어쓰는 쓰기**라 감사 표(`meeting.minutes`)에 앞말과 새 글을 남긴다(N-73 · 쓰기와 같은 트랜잭션).
   */
  async writeMinutes(viewerId: number, id: number, dto: MinutesWriteDto): Promise<MeetingDetailDto> {
    const minutes = dto.minutes.trim();
    await this.lead.manager.transaction(async (em) => {
      const [row] = (await em.query(
        `SELECT id, minutes FROM mtrec WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; minutes: string | null }>;
      if (!row) throw new NotFoundException('회의가 없습니다');
      await em.query(
        `UPDATE mtrec SET minutes = $2, minutes_at = now(), minutes_by = $3 WHERE id = $1`,
        [id, minutes, viewerId],
      );
      await audit(em, 'meeting.minutes', {
        actorId: viewerId, entityId: id, before: { minutes: row.minutes ?? null }, after: { minutes },
      });
    });
    return (await this.meetingDetail(id, { id: viewerId, canManage: true }))!;
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
        // 강사 담당자는 운영 할 일 화면을 못 연다 — 참석자면 그 회의 창(③ 할 일)으로, 아니면 링크 없이 (W11 A' 후속 · lib/meeting-link)
        const [who] = (await em.query(
          `SELECT s.role::text AS role, EXISTS (SELECT 1 FROM mtattd a WHERE a.mt_id = $2 AND a.staff_id = s.id) AS attendee
             FROM staff s WHERE s.id = $1`,
          [dto.toId, id],
        )) as Array<{ role: string; attendee: boolean }>;
        await em.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, $4, 'request', $5)`,
          [dto.toId, viewerId, `회의 할 일 — ${name}`, meetingNotiLink(who?.role ?? '', id, '/ops?tab=todo', who?.attendee === true), NOTI_TITLE.meetingTodo],
        );
      }
    });
    return (await this.meetingDetail(id, { id: viewerId, canManage: true }))!;
  }
}

/**
 * A-01 — 상담 건의 학부모 관계 · 연락처 · 원하는 것을 한 번에 다듬는다. 안 보낸 칸은 undefined(고치기에서 앞 값 그대로),
 * 빈 글은 null(비운다). 연락처는 보호자 번호와 같은 모양(숫자만 010xxxxxxxx)이어야 하고 아니면 400 이다 — DTO 도 같은 판정을 하지만
 * 서비스를 직접 부르는 길(시험 · 다른 서비스)도 같은 문을 지나게 한다.
 */
function leadParentFields(dto: { parentRelation?: string | null; parentPhone?: string | null; want?: string | null }): {
  parentRelation: string | null | undefined; parentPhone: string | null | undefined; want: string | null | undefined;
} {
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
  const raw = text(dto.parentPhone);
  let parentPhone: string | null | undefined = raw;
  if (raw) {
    parentPhone = phoneDigits(raw);
    if (!parentPhone) {
      throw new BadRequestException({ code: 'LEAD_PARENT_PHONE', message: '학부모 연락처가 휴대폰 번호 모양이 아닙니다 — 010-1234-5678 처럼 적어 주세요' });
    }
  }
  return { parentRelation: text(dto.parentRelation), parentPhone, want: text(dto.want) };
}

/** 감사 줄에 남기는 모양 — 연락처는 가린 번호(010-****-5678)만. 안 보낸 칸(undefined)은 싣지 않는다 */
function leadParentAudit(v: { parentRelation?: string | null; parentPhone?: string | null; want?: string | null }): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (v.parentRelation !== undefined) out.parentRelation = v.parentRelation;
  if (v.parentPhone !== undefined) out.parentPhone = v.parentPhone ? maskPhone(v.parentPhone) : null;
  if (v.want !== undefined) out.want = v.want;
  return out;
}
