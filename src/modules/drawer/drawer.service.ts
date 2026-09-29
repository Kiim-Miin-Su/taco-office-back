/** @file-guide
 * 목적: drawer.service.ts — DrawerService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 우측 서랍 — §14~§21 여덟 칸.
 *
 * 서랍은 **전역**이다. 어느 탭에서 열든 같은 것이 보여야 하므로 한 번에 다 내려보낸다 —
 * 칸마다 엔드포인트를 두면 서랍을 열 때마다 왕복이 여덟 번이다.
 *
 * 결재 정규화는 `lib/approval.ts` 가 갖는다. 여기서는 행을 읽어 그 함수에 넘길 뿐이다 —
 * §14 승인 대기함과 §75 결재 흐름이 **같은 함수**를 보게 하는 것이 요점이다 (D-R26).
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryRunner, Repository } from 'typeorm';
import { Lead } from '../../entities';
import {
  PERM_OVERRIDE_COLUMN, PERM_OVERRIDE_KEYS, PERM_OVERRIDE_LABEL, isRole, permGrantBlockedMessage, permGrantIssue, permsOf,
  type ApprovalFlowScope, type PermFlags, type PermOverrideKey,
} from '../../common/perm';
import {
  apFlow, approvalFlowProjection, approvalPlanVisible, labelOf, reqAsked, reqAskedLine, reqTitle, requesterReason, toApState,
  CHREQ_REVIEW_FORBIDDEN_MESSAGE, GPAPACK_TYPE_LABEL, REQ_TYPE_LABEL, RPT_TYPE_LABEL, type ApRow,
} from '../../lib/approval';
import { AUDIT_WRITES, audit, type AuditKey } from '../../lib/audit';
import { payoutConfirmedSql } from '../../lib/rules';
import { kindGroupLabel } from '../../lib/catalog-words';
import { chreqApplicable, chreqAsked, isChreqType, type NormalizedChangeRequest } from '../../lib/change-request';
import { ZoomService } from '../zoom/zoom.service';
import { NOTI_CATEGORIES, NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory, notiTone } from '../../lib/noti';
import { groupByRole, roleLabel } from '../../lib/role-words';
import { START_MIN, END_MIN, effectiveModeOf, kstAt, kstDateOf, writtenRows } from '../../lib/sql';
import { TODO_KEEP_ON_CLEAR, TODO_KEEP_REASON, todoClearable, todoGo, todoSourceLabel } from '../../lib/todo';
import { continueLeadCare } from '../ops/lead-care';
import { KST, isIsoDate, overdueDays, todayKst } from '../../lib/kst';
import { insertWage } from '../../lib/wage';
import { lineAmountVisible, readAcctPrivacy } from '../../lib/acct-privacy';
import {
  LOGIN_ID_ISSUE_MESSAGE, LOGIN_ID_RULE_TEXT, PASSWORD_ISSUE_MESSAGE, TEMP_PASSWORD_RULE_TEXT,
  loginIdIssue, normalizeEmail, normalizeLoginId, normalizeMobile, passwordIssue,
} from '../../lib/account-policy';
import { PHONE_COUNTRIES } from '../../lib/phone';
import { staffRecordTables } from '../../lib/staff-refs';
import { maskEmail, maskPhone } from '../notify/sender';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import { loadState } from '../schedule/schedule.state.repo';
import { issueScheduleUndoStep } from '../schedule/schedule.undo';
import { GpaService } from '../gpa/gpa.service';
import { STAFF_CREATE_ROLES } from './drawer.dto';
import type {
  ApprovalUndoResultDto, ChreqReviewDto, DrawerDto, MemberDto, MemberPermDto, ReqReviewDto, ScheduleHistoryDto,
  StaffCreateDto, StaffPatchDto, TodoCreateDto, TodoPatchDto,
} from './drawer.dto';
import { scheduleHistoryLine } from '../../lib/schedule-history';
import { issueApprovalUndo, readApprovalUndo, type ApprovalUndoPayload, type ReqUndoEffect } from './approval-undo';
import bcrypt from 'bcryptjs';

type R = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const staffNotFound = () => new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 구성원을 찾을 수 없습니다' });
const staffLoginIdTaken = () => new ConflictException({
  code: 'STAFF_LOGIN_ID_TAKEN', message: '그 아이디는 이미 쓰고 있습니다 — 다른 아이디를 정해 주세요(대소문자만 다른 아이디도 같은 아이디입니다)',
});
const staffEmailTaken = () =>
  new ConflictException({ code: 'STAFF_EMAIL_TAKEN', message: '그 이메일은 다른 구성원이 쓰고 있습니다 — 이메일은 한 사람에 하나입니다' });
/** 유일 제약 위반(23505)을 칸에 맞는 409 로 — 동시에 같은 값을 넣은 사람이 있을 때. 오류 원문(값이 든다)은 싣지 않는다 */
const staffUniqueTaken = (e: unknown) =>
  (e as { constraint?: string }).constraint === 'staff_login_id_lower_key' ? staffLoginIdTaken() : staffEmailTaken();

/** 쿼리 한 줄 — EntityManager · QueryRunner 어느 쪽이든 */
type Run = (sql: string, params: unknown[]) => Promise<unknown>;

/** 감사 표의 entity 낱말(대문자) — 결재 줄과 되돌리기 줄이 같은 이름을 쓴다(W11 A' 후속 · 리드 결정) */
const auditEntityOf = (key: AuditKey): string => AUDIT_WRITES.find((w) => w.key === key)!.entity;

/**
 * 방금 남긴 결재 감사 줄의 번호 — 되돌리기 토큰이 이 줄에 묶인다(한 번만 · N-84).
 * `audit()` 은 번호를 돌려주지 않는다(표 파일은 더하기만). 같은 트랜잭션이고 대상 요청 행을 잠근 뒤라
 * 같은 요청에 다른 줄이 끼어들 수 없다 — 그래서 가장 최근 줄이 곧 이 처리의 줄이다.
 */
async function lastApprovalLogId(run: Run, key: AuditKey, entityId: number): Promise<number> {
  const [row] = (await run(
    `SELECT id FROM log WHERE entity = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`, [auditEntityOf(key), entityId],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('방금 남긴 결재 감사 줄을 찾지 못했습니다');
  return Number(row.id);
}

/**
 * 토큰이 묶인 줄이 여전히 **그 요청의 마지막 줄**인가 — 뒤에 결재 · 되돌리기 줄이 하나라도 있으면 그 토큰의 처리는 지난 일이다.
 * 옛 줄(소문자 `req` · `chreq` · N-25)도 같은 요청의 줄이라 대소문자를 가리지 않고 본다. 묶인 줄이 없어도(다른 요청의 줄) 끝난 토큰이다.
 */
async function approvalLogIsLast(run: Run, entity: string, entityId: number, logId: number): Promise<boolean> {
  const rows = (await run(
    `SELECT id FROM log WHERE upper(entity) = $1 AND entity_id = $2 AND id >= $3 ORDER BY id LIMIT 2`, [entity, entityId, logId],
  )) as Array<{ id: string }>;
  return rows.length === 1 && Number(rows[0].id) === logId;
}

/** 아이디 칸 — 규칙에 맞으면 저장할 값(앞뒤 공백만 지움), 아니면 400. 규칙 · 문장은 `lib/account-policy` 한 곳 (W10) */
function staffLoginIdOf(raw: string): string {
  const issue = loginIdIssue(raw);
  if (issue) throw new BadRequestException({ code: 'LOGIN_ID_RULE', message: LOGIN_ID_ISSUE_MESSAGE[issue] });
  return normalizeLoginId(raw);
}

/** 매니저가 적은 임시 비밀번호 — 첫 설정의 새 비밀번호와 **같은 규칙**(`passwordIssue` 한 곳 · W10). 맞지 않으면 400 */
function assertTempPassword(pw: string): void {
  const issue = passwordIssue(pw);
  if (issue) throw new BadRequestException({ code: 'PASSWORD_RULE', message: PASSWORD_ISSUE_MESSAGE[issue] });
}

/**
 * 휴대폰 칸 — 비우면 null, 적었으면 저장 모양(한국 번호는 숫자만 · 해외 번호는 `+국가번호…` · N-103 · lib/phone).
 * 모양이 아니면 400 — 번호 원문은 오류에 싣지 않는다
 */
function staffPhoneOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const phone = normalizeMobile(raw);
  if (!phone) {
    throw new BadRequestException({
      code: 'STAFF_PHONE_INVALID', message: '휴대폰 번호 모양이 아닙니다 — 국가번호를 고르고 번호를 적어 주세요(한국은 010으로 시작)',
    });
  }
  return phone;
}

/**
 * §17 줄마다의 단추 — **서버가 가른다** (W8 · D-R39). 보는 이가 매니저 이상(canManage)이고 그 줄이 강사·매니저일 때만
 * 「수정」이 서고, 자기 줄은 역할 · 초기화 · 사용 중지 · 삭제가 빠진다. 대표·관리자 줄에는 아무것도 서지 않는다.
 */
function staffRowFlags(canManage: boolean, manageable: boolean, self: boolean) {
  const edit = canManage && manageable;
  const other = edit && !self;
  return { canEdit: edit, canChangeRole: other, canResetPassword: other, canToggleActive: other, canDelete: other };
}

/** 권한 예외 칸 이름 — SELECT 에 넣는 칸도 이 표에서만 온다 (N-68 · `common/perm/perm-matrix`) */
const permCols = (alias = ''): string =>
  PERM_OVERRIDE_KEYS.map((key) => `${alias ? `${alias}.` : ''}${PERM_OVERRIDE_COLUMN[key]}`).join(', ');

/** 한 줄의 `can_*` 칸 → 예외 다섯 칸(켬 true · 끔 false · 역할 따름 null). 모르는 값은 역할 따름으로 읽는다 */
function overridesOfRow(r: R): Record<PermOverrideKey, boolean | null> {
  const out = {} as Record<PermOverrideKey, boolean | null>;
  for (const key of PERM_OVERRIDE_KEYS) {
    const v = r[PERM_OVERRIDE_COLUMN[key]];
    out[key] = v === true ? true : v === false ? false : null;
  }
  return out;
}

/**
 * §17 수정 창의 권한 예외 다섯 칸 (N-68) — 적힌 예외 · 역할 기본값 · 결론. **판정은 `permsOf` 한 곳**이다 —
 * 로그인 판정(`AuthService.currentUser`)과 같은 함수라 여기 보이는 결론이 곧 그 사람의 다음 요청 판정이다.
 */
function memberPerms(r: R): MemberPermDto[] {
  const role = String(r.role);
  const overrides = overridesOfRow(r);
  const base = isRole(role) ? permsOf(role) : null;
  const eff = isRole(role) ? permsOf(role, overrides) : null;
  return PERM_OVERRIDE_KEYS.map((key) => ({
    key, label: PERM_OVERRIDE_LABEL[key], override: overrides[key],
    roleDefault: base?.[key] ?? false, effective: eff?.[key] ?? false,
  }));
}

@Injectable()
export class DrawerService {
  constructor(
    @InjectRepository(Lead) private readonly anyRepo: Repository<Lead>,
    /** 변경 요청 반영은 **기존 일정 쓰기를 그대로 탄다** — 규칙을 두 벌 만들지 않는다 (C42) */
    private readonly schedWrite?: ScheduleWriteService,
    /** 줌 갈래도 같은 이유로 **줌 배정 경로를 그대로 탄다** (C48) */
    private readonly zoom?: ZoomService,
    /** §14 「GPA 회차 요청」 승인은 **GPA 기록 함수를 그대로** 부른다 — 기록 규칙을 두 벌 만들지 않는다 (N-99) */
    private readonly gpa?: GpaService,
  ) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /**
   * §14 리포트·건의·빠진 것과 §75 결재 갈래를 읽어 공통 ApRow 한 모양으로 만든다.
   * 지정 공개 기획(N-72)은 **여기서 거른다** — 보는 사람에게 안 보이는 기획은 줄이 되지 않는다(두 투영이 같은 줄을 본다 · W11 A' 후속).
   */
  private async approvalRows(viewerId: number, flowScope: ApprovalFlowScope): Promise<ApRow[]> {
    const rows: ApRow[] = [];

    // §14의 강사 리포트 전건 큐. 대표 보고(RPT)와 수업 리포트(REP)는 다른 표다.
    for (const r of await this.q(
      `SELECT r.id, r.ser_id, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state,
              r.reject_reason, r.teacher_id, s.name AS teacher_name,
              COALESCE(string_agg(st.name, ' · ' ORDER BY st.id), '학생 없음') AS student_names,
              ${kstAt(`COALESCE(r.reviewed_at, r.submitted_at, r.written_at, r.on_date::timestamptz)`)} AS at
         FROM rep r
         LEFT JOIN staff s ON s.id = r.teacher_id
         LEFT JOIN rep_stu rs ON rs.rep_id = r.id
         LEFT JOIN stu st ON st.id = rs.student_id
        WHERE r.state = ANY(ARRAY['wait','ok','rej']::rep_state_t[])
        GROUP BY r.id, s.name`,
    )) {
      rows.push({
        kind: 'rep', id: Number(r.id),
        title: `리포트 · ${String(r.student_names)} ${String(r.on_date)}`,
        sub: null, byId: num(r.teacher_id), byName: str(r.teacher_name), at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason),
        go: `/reports?review=approval&serId=${Number(r.ser_id)}&onDate=${String(r.on_date)}`,
      });
    }

    // §14 「건의 사항」 — 강사 전용 건의 원장의 미처리 행. 답변은 운영 화면의 전용 흐름이 맡는다.
    for (const r of await this.q(
      `SELECT g.id, g.category, g.body, g.state, g.staff_id, s.name AS by_name,
              ${kstAt(`g.created_at`)} AS at
         FROM suggestion g JOIN staff s ON s.id = g.staff_id`,
    )) {
      rows.push({
        kind: 'suggestion', id: Number(r.id), title: '건의 사항',
        sub: String(r.body), byId: num(r.staff_id), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: null, go: '/ops?view=suggestions', applicable: false,
      });
    }

    /* §14 「빠진 것」 — 별도 상태를 저장하지 않고 SER_OCC의 현재 자원 배정을 매번 계산한다.
       원문 카드가 요구한 줌 미배정만 우선 투영한다. 교재·안내·리포트 누락은 §34 현황판의
       네 마크이며 승인 요청이 아니므로 여기서 중복 행을 만들지 않는다. */
    for (const r of await this.q(
      `SELECT o.id, o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              s.title, s.kind_key, o.teacher_id, t.name AS teacher_name,
              ${kstAt(`lower(o.span)`)} AS at
         FROM ser_occ o
         JOIN ser s ON s.id = o.ser_id
         -- 회차의 실제 방식 — 그 회차만 온라인/현장으로 바꾼 예외(exc.mode)가 이긴다 (N-56 · lib/sql 한 조각)
         LEFT JOIN exc e ON e.ser_id = o.ser_id AND e.on_date = o.on_date
         LEFT JOIN staff t ON t.id = o.teacher_id
        WHERE NOT o.canceled AND ${effectiveModeOf('e', 's')} = 'online' AND o.zacc_id IS NULL
          AND lower(o.span) >= now() AND lower(o.span) < now() + interval '30 days'`,
    )) {
      rows.push({
        kind: 'missing', id: Number(r.id),
        title: `줌 계정 미배정 · ${str(r.title) ?? String(r.kind_key)}`,
        sub: [str(r.teacher_name), str(r.on_date)].filter(Boolean).join(' · '),
        byId: num(r.teacher_id), byName: str(r.teacher_name), at: String(r.at),
        state: 'waiting', why: null, go: `/schedule?date=${String(r.on_date)}`, applicable: false,
      });
    }

    for (const r of await this.q(
      `SELECT r.id, r.rpt_type, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state, r.reject_reason,
              r.sent_by, sb.name AS sent_by_name,
              ${kstAt(`COALESCE(r.sent_at, r.on_date::timestamptz)`)} AS at
         FROM rpt r
         LEFT JOIN staff sb ON sb.id = r.sent_by
        -- 아직 안 낸 초안은 아무도 기다리지 않는다.
        -- 한동안 <> 'na' 였는데 rpt 에 'na' 라는 낱말이 없어서 이 줄이 **아무 일도 안 했다** —
        -- 초안이 승인 대기함에 떠서 배지 숫자를 올리고 있었다.
        WHERE r.state <> 'draft'`,
    )) {
      rows.push({
        kind: 'rpt', id: Number(r.id),
        title: `${labelOf(RPT_TYPE_LABEL, String(r.rpt_type))} 보고`,
        /**
         * **올린 사람을 싣는다.** 여기는 오래 `byId: null, byName: null` 이었고 주석이
         * 「RPT 에는 아직 제출자 FK 가 없다」라 적어 두었는데, **C85-a 가 `rpt.sent_by` 를 만들었다**
         * (서명줄에 이름이 이미 뜬다). 주석이 낡은 채로 남아 세 가지가 조용히 죽어 있었다 —
         * §75 의 「되돌아온 것」·「내가 올린 것」은 `byId === viewerId` 로 고르므로 **보고가 한 건도
         * 못 들어갔고**, 줄마다 올린 사람이 「알 수 없음」이었다. 옛 보고는 도장이 없어 여전히 null 이다 (N-25).
         */
        sub: String(r.on_date), byId: num(r.sent_by), byName: str(r.sent_by_name), at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason),
        go: `/exec?view=${String(r.rpt_type)}&date=${String(r.on_date)}&rpt=${Number(r.id)}`,
      });
    }

    for (const r of await this.q(
      `SELECT p.id, p.title, p.stage, to_char(p.due_on, 'MM-DD') AS due_on, ${kstAt(`p.created_at`)} AS at,
              p.owner_id, s.name AS owner_name, rejected.reason AS reject_reason,
              -- W11 · N-72 공개 범위 재료 — 줄을 만들기 전에 approvalPlanVisible 로 거르고 줄에는 싣지 않는다(lib/approval)
              p.share, (SELECT COALESCE(array_agg(pp.staff_id), '{}') FROM plan_pick pp WHERE pp.plan_id = p.id) AS pick_ids
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id
         LEFT JOIN LATERAL (
           SELECT NULLIF(l.after->>'reason', '') AS reason
             FROM log l
            WHERE lower(l.entity) = 'plan' AND l.entity_id = p.id
              AND lower(l.action) IN ('rework', 'reject')
            ORDER BY l.at DESC, l.id DESC LIMIT 1
         ) rejected ON true`,
    )) {
      const visible = approvalPlanVisible({
        share: str(r.share), ownerId: num(r.owner_id), pickIds: ((r.pick_ids as unknown[] | null) ?? []).map(Number),
      }, viewerId, flowScope);
      if (!visible) continue;
      const state = toApState(str(r.stage));
      const sub = [str(r.owner_name), r.due_on ? `마감 ${String(r.due_on)}` : null].filter(Boolean).join(' · ');
      rows.push({
        kind: 'plan', id: Number(r.id), title: String(r.title),
        sub: sub || null,
        byId: num(r.owner_id), byName: str(r.owner_name), at: String(r.at),
        state, why: state === 'back' ? str(r.reject_reason) : null,
        go: `/ops?tab=plan&plan=${Number(r.id)}`,
      });
    }

    for (const r of await this.q(
      `SELECT q.id, q.req_type, q.payload, q.state, q.reject_reason, q.staff_id, s.name AS by_name,
              ${kstAt(`q.created_at`)} AS at
         FROM req q LEFT JOIN staff s ON s.id = q.staff_id`,
    )) {
      const reqType = String(r.req_type);
      const asked = reqAskedLine(reqType, r.payload);
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      rows.push({
        kind: 'req', id: Number(r.id),
        // 원문 §14 카드의 회색 제목 「박하경 · Quiz 대비」 — 새 입력(N-99)의 스냅숏이 있을 때만, 옛 줄은 「갈래 이름 요청」
        title: reqTitle(reqType, r.payload),
        // 「무엇을 바라는가」를 줄에 적는다 — 근거를 안 보고 누르는 승인이 되지 않도록 (§14)
        sub: asked,
        byId: num(r.staff_id), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason),
        go: `/ops?tab=todo&request=${Number(r.id)}`,
        reqType, asked,
        // 강사가 적은 사유(§14 인용 줄 · g2 14-4). 옛 교재 변경 요청은 그 말이 `message` 칸에 있다
        reason: requesterReason([asked], payload.reason, payload.message),
      });
    }

    for (const r of await this.q(
      `SELECT c.id, c.req_type, c.payload, c.state, c.reason, c.reject_reason, c.apply_all,
              c.by_id, s.name AS by_name,
              to_char(c.on_date,'YYYY-MM-DD') AS on_date,
              ser.title AS ser_title, t.name AS teacher_name, rm.name AS room_name, z.label AS zacc_label,
              ${kstAt(`c.created_at`)} AS at
         FROM chreq c
         LEFT JOIN staff s ON s.id = c.by_id
         LEFT JOIN ser ON ser.id = c.ser_id
         LEFT JOIN staff t ON t.id = (c.payload->>'teacherId')::bigint
         LEFT JOIN room rm ON rm.id = (c.payload->>'roomId')::bigint
         LEFT JOIN zacc z ON z.id = (c.payload->>'zaccId')::bigint`,
    )) {
      const reqType = String(r.req_type);
      const asked = chreqAsked(reqType, r.payload, {
        teacherName: str(r.teacher_name), roomName: str(r.room_name), zaccLabel: str(r.zacc_label),
      });
      const state = toApState(str(r.state));
      // 반려 사유는 이제 제 칸이 있다 (v4.18) — 옛 행은 신청 사유 칸에만 있어 그것으로 갈음한다
      const why = state === 'back' ? (str(r.reject_reason) ?? str(r.reason)) : null;
      rows.push({
        kind: 'chreq', id: Number(r.id),
        title: `${labelOf(REQ_TYPE_LABEL, reqType)} 요청`,
        // 원문 §20 이력 줄의 모양 — 「MAP Reading 8/28 강사 → KJ (이 주만)」
        sub: [str(r.ser_title), str(r.on_date), asked, r.apply_all === true ? '(이후 전체)' : '(이 회차만)']
          .filter(Boolean).join(' · '),
        byId: num(r.by_id), byName: str(r.by_name), at: String(r.at),
        state, why,
        go: `/schedule?changeRequest=${Number(r.id)}`,
        reqType, asked, applicable: chreqApplicable(reqType, r.payload),
        // 신청 사유(§14 인용 줄 · g2 14-4) — 옛 반려 행은 그 글이 반려 사유 자리에 이미 서므로 두 번 싣지 않는다
        reason: requesterReason([asked, why], r.reason),
      });
    }

    // 다섯 번째 — 자료 요청 (§41). 다학생은 한 줄의 이름으로 모으고 작성자를 보존한다.
    for (const r of await this.q(
      `SELECT g.id, g.pack_type, g.title, g.state, g.memo, g.created_by, b.name AS by_name,
              to_char(g.effective_on, 'MM-DD') AS effective_on,
              string_agg(s.name, ' · ' ORDER BY s.name) AS stu_names,
              ${kstAt(`g.created_at`)} AS at
         FROM gpapack g
         LEFT JOIN staff b ON b.id = g.created_by
         LEFT JOIN gpapack_student gs ON gs.gpapack_id = g.id
         LEFT JOIN stu s ON s.id = gs.student_id
        GROUP BY g.id, b.name`,
    )) {
      /*
       * 부제는 원문 §75 줄 그대로 「학생 · 기한」이다 — 메모는 부제가 아니라 올린 사람의 말이라 §14 인용 줄로 간다.
       * 제목은 종류 이름을 **두 번 말하지 않는다**(g2 14-7) — 시드·옛 행의 제목이 종류 이름과 같은 글이라
       * 「시험 대비 자료 요청 · 시험 대비 자료 요청」이 서고 있었다.
       */
      const kindTitle = `${labelOf(GPAPACK_TYPE_LABEL, String(r.pack_type))} 자료 요청`;
      const ownTitle = str(r.title)?.trim() || null;
      const title = ownTitle && ownTitle !== kindTitle ? `${kindTitle} · ${ownTitle}` : kindTitle;
      const sub = [str(r.stu_names), r.effective_on ? `기한 ${String(r.effective_on)}` : null]
        .filter(Boolean).join(' · ') || null;
      rows.push({
        kind: 'gpapack', id: Number(r.id),
        title, sub,
        byId: num(r.created_by), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: null,
        go: `/books?tab=requests&pack=${Number(r.id)}`,
        reason: requesterReason([title, sub], r.memo),
      });
    }

    return rows;
  }

  async all(
    viewerId: number,
    canApprove: boolean,
    canSeeAll: boolean,
    notiAll = false,
    flowScope: ApprovalFlowScope = 'none',
    canWage = false,
    /** §17 줄 단추(수정·초기화·사용 중지·삭제)를 세울 수 있는가 — canAdminPage + canCrudAll (쓰기 경로의 @Perm 과 같은 둘) */
    canManageStaff = false,
    /** §17 수정 창의 권한 예외 토글을 세울 수 있는가 — 대표 판정 `canCeoSetPermOverride` (N-68) */
    canSetPerms = false,
    /**
     * 시급 비공개(N-94 · W11 M2)를 지나는가 — 비공개 열람 `canHide`. 스위치가 켜져 있고 못 지나면 남의 지금 시급을 싣지 않는다.
     * 컨트롤러는 늘 실제 값을 넘긴다 — 기본값 true 는 스위치를 모르는 옛 호출(시험)이 전과 같은 값을 받게 하려는 것이다.
     */
    canHide = true,
  ): Promise<DrawerDto> {
    const approvalRows = await this.approvalRows(viewerId, flowScope);
    // 변경 요청 줄은 시간표를 쓸 수 있어야 단추가 선다 — 쓰기(reviewChangeRequest)와 같은 판정 (P1 CROSS-CUT · D-R39)
    const approvals = apFlow(approvalRows, viewerId, canApprove, canWage, canSeeAll);
    const approvalFlow = approvalFlowProjection(approvalRows, viewerId, flowScope);

    // 할 일 — 강사는 자기 것만 (주고받은 것). 화면이 안 걸러도 서버가 거른다 (D-R39)
    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on,
              t.from_id, t.to_id, f.name AS from_name, s.name AS to_name,
              t.mt_id, t.cpl_id, t.cons_id, t.plan_id, t.lead_id,
              -- 수업에 걸린 할 일은 그 회차가 **그려지는 날**로 연다(옮긴 회차 · §64 연결 수업 칩과 같은 주소 · W11 A' 후속 2)
              t.ser_id, to_char(t.on_date,'YYYY-MM-DD') AS lesson_on, to_char(${kstDateOf('lower(lo.span)')},'YYYY-MM-DD') AS lesson_drawn
         FROM todo t
         LEFT JOIN staff f ON f.id = t.from_id
         LEFT JOIN staff s ON s.id = t.to_id
         LEFT JOIN ser_occ lo ON lo.ser_id = t.ser_id AND lo.on_date = t.on_date
        WHERE $2::boolean OR t.to_id = $1 OR t.from_id = $1
        ORDER BY t.done, t.due_on NULLS LAST, t.id`,
      [viewerId, canSeeAll],
    )).map((r) => ({
      id: Number(r.id), title: String(r.title),
      fromId: num(r.from_id), toId: num(r.to_id),
      fromName: str(r.from_name), toName: str(r.to_name),
      dueOn: str(r.due_on), done: r.done === true, src: String(r.src), srcLabel: todoSourceLabel(String(r.src)),
      overdueDays: r.done === true ? 0 : overdueDays(str(r.due_on)),
      // 출처가 있으면 원본으로 돌아갈 수 있다 (§15 규칙) — 운영 §64 와 같은 함수 한 곳이 그 한 건을 여는 주소를 짓는다
      // (회의 · 컴플레인 · 기획 · 컨설팅 · 상담 사후 관리 · 수업 — W11 A' · N-86 · A' 후속 2)
      go: todoGo({
        mtId: r.mt_id, cplId: r.cpl_id, consId: r.cons_id, planId: r.plan_id, leadId: r.lead_id,
        serId: r.ser_id, onDate: str(r.lesson_on), drawnOn: str(r.lesson_drawn),
      }),
      // 「끝난 것 지우기」가 지울 수 있는 줄인가 — 판정은 lib/todo 한 곳(지우는 쓰기의 WHERE 와 같은 목록)
      clearable: todoClearable(String(r.src)),
      clearBlockedReason: todoClearable(String(r.src)) ? null : TODO_KEEP_REASON,
    }));

    /* §16 — 기본은 최근 30일만 **보여 준다.** 지우는 것이 아니다 (N-7 · D-16).
       창 밖에 몇 건이 남아 있는지 함께 세어, 화면이 「없어진 것이 아니라 안 보이는 것」이라고 말할 수 있게 한다. */
    const windowDays = notiAll ? 0 : NOTI_WINDOW_DAYS;
    const notis = (await this.q(
      `SELECT n.id, n.title, n.body, n.link, n.category, n.to_id, n.read_at, f.name AS from_name,
              f.role::text AS from_role,
              ${kstAt(`n.created_at`)} AS at
         FROM noti n LEFT JOIN staff f ON f.id = n.from_id
        WHERE ($2::boolean OR n.to_id = $1)
          AND ($3::int = 0 OR n.created_at >= now() - make_interval(days => $3::int))
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC`,
      [viewerId, canSeeAll, windowDays],
    )).map((r) => {
      const link = str(r.link);
      const category = notiCategory(str(r.category), link);
      const fromRole = str(r.from_role);
      return {
        // 제목은 제목 칸이 생긴 뒤 적는 쓰기만 갖는다 — 옛 행은 null 이고 화면은 본문을 한 줄로 그린다 (g2 16-1)
        id: Number(r.id), title: str(r.title), body: String(r.body), fromName: str(r.from_name),
        // 보낸 이의 역할 낱말은 §17 과 같은 표에서 꺼낸다 (g2 16-2 · D-R18) — 시스템이 보낸 것은 null
        fromRoleLabel: fromRole ? roleLabel(fromRole) : null,
        toId: num(r.to_id), link, read: r.read_at !== null, at: String(r.at),
        tone: notiTone(link),
        category, categoryLabel: NOTI_CATEGORY_LABEL[category],
      };
    });
    const [older] = await this.q<{ n: string }>(
      `SELECT count(*)::text n FROM noti n
        WHERE ($2::boolean OR n.to_id = $1)
          AND $3::int > 0 AND n.created_at < now() - make_interval(days => $3::int)`,
      [viewerId, canSeeAll, windowDays],
    );
    const notiCategories = NOTI_CATEGORIES.map((key) => ({
      key,
      label: NOTI_CATEGORY_LABEL[key],
      count: notis.filter((noti) => noti.category === key).length,
    }));

    // 지금 시급은 **볼 수 있는 사람에게만** 싣는다(canWage · D-R39) — 못 보면 조회 자체를 안 한다. 회차의 시급과 같은 정의(오늘 이하의 마지막 줄 · lib/wage)
    // 구성원 목록(§17)도 전체를 볼 수 있는 사람(canCrudAll)에게만 싣는다 — 강사에게는 **자기 한 줄**뿐이다.
    // 아이디 · 이메일도 같다(W10 부터 둘은 다른 칸이다). 강사 화면은 서랍을 그리지 않지만 경로는 열려 있으므로 SELECT 단계에서 뺀다 (보안 검수 0925 · D-R39)
    // 휴대폰도 연락처라 전체를 다루는 사람(canCrudAll)에게만 싣는다 — 아니면 SELECT 단계에서 뺀다 (W8)
    // 시급 비공개(N-94) — 켜져 있고 비공개 열람이 없으면 남의 지금 시급은 null 이다(본인 줄 · 적용일은 그대로).
    // 판정은 회계 정산 줄 · 시급 이력과 같은 `lineAmountVisible` 하나다. 비공개 열람이 있는 사람에게는 표를 읽지 않는다
    const wagePrivate = canWage && !canHide
      ? (await readAcctPrivacy({ query: (sql: string, p?: unknown[]) => this.q(sql, p ?? []) })).wage.private
      : false;
    const members = (await this.q(
      `SELECT s.id, s.name, s.login_id, s.email, s.role::text AS role, s.title, s.tz, s.active,
              CASE WHEN $3::boolean THEN s.phone END AS phone, s.must_change_credentials,
              to_char(s.hired_on,'YYYY-MM-DD') AS hired_on,
              (s.role::text = ANY($5::text[])) AS manageable, ${permCols('s')},
              w.rate AS wage_rate, to_char(w.from_date,'YYYY-MM-DD') AS wage_from,
              (s.role = 'teacher' AND s.active) AS wageable
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT rate, from_date FROM wage
            WHERE $2::boolean AND staff_id = s.id AND from_date <= $1::date
            ORDER BY from_date DESC LIMIT 1
         ) w ON true
        WHERE $3::boolean OR s.id = $4
        ORDER BY s.active DESC, s.id`,
      [todayKst(), canWage, canSeeAll, viewerId, [...STAFF_CREATE_ROLES]],
    )).map((r) => ({
      id: Number(r.id), name: String(r.name), loginId: String(r.login_id), email: str(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: canWage && r.wage_rate != null && lineAmountVisible(true, wagePrivate, canHide, Number(r.id) === viewerId)
        ? Number(r.wage_rate) : null,
      wageFrom: canWage ? str(r.wage_from) : null,
      // 시급 줄을 둘 수 있는 줄은 표가 가른다(활성 강사) — 화면이 role 을 보지 않게 (D-R39)
      wageable: canWage && r.wageable === true,
      mustChangeCredentials: r.must_change_credentials === true,
      phone: str(r.phone),
      hiredOn: str(r.hired_on),
      // 「수정」·「비밀번호 초기화」·「사용 중지」·「삭제」가 서는 줄도 표가 가른다(강사·매니저 · 자기 줄 제외) — W8
      ...staffRowFlags(canManageStaff, r.manageable === true, Number(r.id) === viewerId),
      // N-68 — 권한 예외는 구성원을 다루는 사람에게만 싣고, 토글은 대표 판정 · 강사·매니저 줄 · 자기 줄 아님일 때만 선다
      canEditPerms: canManageStaff && canSetPerms && r.manageable === true && Number(r.id) !== viewerId,
      perms: canManageStaff ? memberPerms(r) : null,
    }));

    /* 묶음은 **같은 배열**에서 낸다 — 따로 질의하면 목록과 인원이 갈린다 (D-R37 · D-R22) */
    const memberGroups = groupByRole(members);

    const tzGroups = (await this.q(`SELECT id, name, tz FROM tzg ORDER BY id`))
      .map((r) => ({ id: Number(r.id), name: String(r.name), tz: String(r.tz) }));

    const kinds = (await this.q(
      `SELECT key, name, color, cap, grp::text AS grp, rep FROM kind ORDER BY sort`,
    )).map((r) => {
      const grp = String(r.grp);
      return {
        key: String(r.key), name: String(r.name), color: String(r.color),
        // 묶음 이름은 서버가 만든다 — 화면이 코드표를 다시 적으면 원문과 갈린다 (D-R18)
        cap: Number(r.cap), grp, grpLabel: kindGroupLabel(grp), rep: r.rep === true,
      };
    });

    const changeReqs = (await this.q(
      `SELECT c.id, c.req_type, c.ser_id, to_char(c.on_date,'YYYY-MM-DD') AS on_date,
              c.reason, c.reject_reason, c.payload, c.state, c.apply_all, s.name AS by_name,
              t.name AS teacher_name, rm.name AS room_name, z.label AS zacc_label,
              ${kstAt(`c.created_at`)} AS at
         FROM chreq c
         LEFT JOIN staff s ON s.id = c.by_id
         LEFT JOIN staff t ON t.id = (c.payload->>'teacherId')::bigint
         LEFT JOIN room rm ON rm.id = (c.payload->>'roomId')::bigint
         LEFT JOIN zacc z ON z.id = (c.payload->>'zaccId')::bigint
        WHERE $2::boolean OR c.by_id = $1
        ORDER BY c.created_at DESC`,
      [viewerId, canSeeAll],
    )).map((r) => {
      const reqType = String(r.req_type);
      if (!isChreqType(reqType)) throw new Error(`CHREQ.req_type 계약 밖의 값입니다: ${reqType}`);
      return {
        id: Number(r.id), reqType, serId: Number(r.ser_id),
        onDate: String(r.on_date), reason: String(r.reason),
        rejectReason: str(r.reject_reason), state: String(r.state),
        byName: str(r.by_name),
        asked: chreqAsked(reqType, r.payload, {
          teacherName: str(r.teacher_name), roomName: str(r.room_name), zaccLabel: str(r.zacc_label),
        }),
        applyAll: r.apply_all === true, at: String(r.at),
      };
    });

    // 줌 — 로그인 정보(login_secret · meeting_pw_enc)는 **SELECT 에 넣지 않는다**.
    // 학생 참가 링크와 같은 화면에 두지 않는 것이 규칙이다 (erd V9).
    // 참가 링크도 §21 을 다루는 사람(canCrudAll)에게만 — 강사에게는 이름과 건수만 간다 (보안 검수 0925 · D-R39)
    const zoomAccounts = (await this.q(
      `SELECT z.id, z.label, CASE WHEN $1::boolean THEN z.join_url END AS join_url, z.active,
              (SELECT count(*) FROM ser_occ o WHERE o.zacc_id = z.id AND NOT o.canceled)::int AS assigned,
              (SELECT count(*) FROM ser_occ a JOIN ser_occ b
                      ON a.zacc_id = b.zacc_id AND a.id < b.id AND a.span && b.span
                WHERE a.zacc_id = z.id AND NOT a.canceled AND NOT b.canceled)::int AS overlaps
         FROM zacc z ORDER BY z.active DESC, z.id`,
      [canSeeAll],
    )).map((r) => ({
      id: Number(r.id), label: String(r.label), joinUrl: str(r.join_url),
      active: r.active === true, assigned: Number(r.assigned), overlaps: Number(r.overlaps),
    }));

    /* §38~§41 공용 「할 일」 바. 화면이 REQ/TODO/GUIDE/ZACC를 다시 세면
       같은 업무가 탭마다 다른 숫자가 된다. 이 응답 한 곳에서만 분류한다. */
    const [guideOpen] = await this.q<{ n: string }>(
      `SELECT count(*)::text n FROM guide WHERE state <> 'read'::guide_state_t`,
    );
    const openTodos = todos.filter((todo) => !todo.done);
    const workItems = [
      { key: 'schedule', label: '스케줄', count: changeReqs.filter((row) => ['open', 'pending', 'wait'].includes(row.state)).length, go: '/schedule' },
      { key: 'consulting', label: '상담', count: openTodos.filter((todo) => todo.src === 'consulting').length, go: '/consulting' },
      { key: 'accounting', label: '회계', count: approvals.inbox.filter((row) => row.go === '/accounting').length, go: '/accounting' },
      { key: 'books', label: '교재', count: approvals.inbox.filter((row) => row.go === '/books').length, go: '/books' },
      { key: 'guides', label: '수업 안내', count: Number(guideOpen?.n ?? 0), go: '/guides' },
      { key: 'zoom', label: '줌 계정', count: zoomAccounts.reduce((sum, row) => sum + row.overlaps, 0), go: '/zoom' },
    ];
    // N-52 요청함 「내 지출 신청」 머리 — **신청자가 나인 줄만** 센다(목록은 칸을 열 때 따로 받는다 · D-R37)
    const [mine] = await this.q<{ total: string; pending: string; rejected: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE state = 'pending')::text AS pending,
              count(*) FILTER (WHERE state = 'rejected')::text AS rejected
         FROM expense WHERE requester_id = $1`,
      [viewerId],
    );
    const workTotal = workItems.reduce((sum, item) => sum + item.count, 0);
    const workSummary = {
      total: workTotal,
      now: Math.min(workTotal, approvals.inboxCount + openTodos.filter((todo) => todo.overdueDays > 0).length),
      items: workItems,
    };

    return {
      approvals, approvalFlow, todos, notis, notiCategories,
      notiWindowDays: windowDays,
      notiOlderCount: Number(older?.n ?? 0),
      members, memberGroups, tzGroups, kinds, changeReqs, zoomAccounts, workSummary,
      tz: KST,
      canAddMember: canSeeAll,
      // 구성원 만들기 · 수정 창의 휴대폰 국가번호 목록 — 첫 설정과 같은 표(N-103 · lib/phone)
      phoneCountries: PHONE_COUNTRIES.map((c) => ({ ...c })),
      // 규칙 문장도 서버가 준다 — 화면이 규칙을 따로 적지 않는다 (W10 · D-R18)
      loginIdRule: LOGIN_ID_RULE_TEXT,
      tempPasswordRule: TEMP_PASSWORD_RULE_TEXT,
      canWage,
      myExpenses: { total: Number(mine?.total ?? 0), pending: Number(mine?.pending ?? 0), rejected: Number(mine?.rejected ?? 0) },
    };
  }

  /* ══ 쓰기 — §14~§16의 입력은 모두 여기서 DB 권한을 다시 검사한다 ═══════ */

  /**
   * §17 「+ 구성원」 (C97 · 테스트 시나리오 D-41 「신규 강사 등록」).
   * 역할은 강사·매니저뿐(DTO enum · 대표·관리자 계정은 이 길로 만들지 않는다 — 권한 상승 경로를 두지 않는다).
   * 아이디는 형식 자유(띄어쓰기만 없음) · 대소문자 무시 유일, 이메일은 선택(적으면 유일) — 표의 유일 색인이 마지막에 막고
   * 먼저 읽어 409 문장을 준다(W10). 시간대는 `tzg` 에 있는 값만(C41 과 같은 낱말 `TZ_UNKNOWN`).
   * 비밀번호는 매니저가 적은 임시 비밀번호를 bcryptjs 해시로만 저장하고 어느 응답 · 기록에도 싣지 않는다.
   * 시급을 적었으면 **같은 트랜잭션**에 `insertWage`(입사일 또는 오늘부터 · 소급 없음).
   *
   * **시급을 적으려면 `canWage` 여야 한다**(S4). `insertWage` 를 타는 다른 두 경로 — `POST /accounting/wages`
   * (`@Perm('canAdminPage','canWage')`)와 §14 시급 요청 승인(`reviewRequest` 의 `WAGE_REVIEW_FORBIDDEN`) — 는 둘 다
   * 요구하는데 이 자리만 안 물었다. `can_wage=false` 예외가 걸린 매니저가 「+ 구성원」으로 시급을 세우면
   * **그 예외가 존재하는 이유 자체를 우회한다.** 구성원을 만드는 것과 시급을 정하는 것은 다른 권한이므로
   * 만들기 자체는 막지 않고 **시급 칸만** 막는다 — 시급을 비우면 그대로 만들어진다.
   */
  async createStaff(
    viewerId: number, canWage: boolean, dto: StaffCreateDto,
    /** 보는 사람의 결론 권한(사람별 예외까지) — 권한 한도. 모르면 만들지 않는다(닫힌 쪽 · W11 A' 후속) */
    viewerPerms: PermFlags | null = null,
  ): Promise<MemberDto> {
    const today = todayKst();
    /*
     * 권한 한도 (W11 A' 후속 · 리드 결정) — 새 계정이 받게 될 권한(역할 기본값) 중 **내게 없는 것**이 있으면 만들지 않는다.
     * 사람별 예외로 좁혀진 매니저가 임시 비밀번호로 새 매니저 계정을 만들어 스스로 쓰는 우회가 여기서 닫힌다.
     * 강사 계정은 받는 권한이 없어 누구나 만든다 · 좁혀지지 않은 매니저 · 대표는 지금과 같다(P1).
     */
    const target = isRole(dto.role) ? permsOf(dto.role, null) : null;
    const grant = target && viewerPerms ? permGrantIssue(viewerPerms, null, target) : 'canAdminPage';
    if (grant) {
      throw new ForbiddenException({
        code: 'PERM_GRANT_FORBIDDEN',
        message: permGrantBlockedMessage(grant, { kind: 'create', role: isRole(dto.role) ? dto.role : 'manager' }),
      });
    }
    if (dto.wageRate != null && !canWage) {
      throw new ForbiddenException({
        code: 'WAGE_SET_FORBIDDEN',
        message: '시급을 다룰 권한이 필요합니다 — 시급을 비우고 만든 뒤 시급 담당자가 「시급 수정」으로 세울 수 있습니다',
      });
    }
    // 모양 거절은 DB 를 읽기 전에 — 아이디 · 임시 비밀번호 규칙은 lib/account-policy 한 곳 (W10)
    const loginId = staffLoginIdOf(dto.loginId);
    assertTempPassword(dto.password);
    // 휴대폰은 숫자만 저장한다 — 첫 설정의 문자 확인(SENS)이 같은 모양을 본다 (lib/account-policy)
    const phone = staffPhoneOf(dto.phone);
    const tz = dto.tz?.trim() || KST;
    const [known] = (await this.q(`SELECT tz FROM tzg WHERE tz = $1`, [tz])) as Array<{ tz: string }>;
    if (!known) {
      throw new ConflictException({ code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요' });
    }
    const [idTaken] = (await this.q(`SELECT id FROM staff WHERE lower(login_id) = lower($1)`, [loginId])) as Array<{ id: string }>;
    if (idTaken) throw staffLoginIdTaken();
    const email = dto.email ? normalizeEmail(dto.email) : null;
    if (email) {
      const [taken] = (await this.q(`SELECT id FROM staff WHERE lower(email) = $1`, [email])) as Array<{ id: string }>;
      if (taken) throw staffEmailTaken();
    }
    const hiredOn = dto.hiredOn ?? today;
    /*
     * 비밀번호는 **매니저가 적은 임시 비밀번호**다 (W10 · 답변 2026-09-26) — 만든 사람도 아는 값이므로 첫 설정을 걸어 둔다.
     * 첫 로그인 때 본인이 휴대폰 · 이메일을 코드로 확인하고 새 비밀번호로 바꾼다(지금 비밀번호와 같으면 막힌다).
     */
    const hash = await bcrypt.hash(dto.password, 10);
    const id = await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      let made: { id: string };
      try {
        [made] = (await m.query(
          `INSERT INTO staff (name, login_id, email, phone, role, title, tz, password_hash, hired_on, active, must_change_credentials)
           VALUES ($1, $2, $3, $4, $5::role_t, $6, $7, $8, $9::date, true, true) RETURNING id`,
          [dto.name, loginId, email, phone, dto.role, dto.title?.trim() || null, tz, hash, hiredOn],
        )) as Array<{ id: string }>;
      } catch (e) {
        // 동시에 같은 아이디 · 이메일로 만든 사람이 있으면 표의 유일 색인이 마지막에 막는다 — 오류 원문(값이 든다) 대신 같은 409 문장
        if ((e as { code?: string }).code === '23505') throw staffUniqueTaken(e);
        throw e;
      }
      const staffId = Number(made.id);
      let wage: { fromDate: string } | null = null;
      if (dto.wageRate != null) {
        // 입사일이 오늘보다 앞이면 오늘부터 — 지난 날짜로는 못 적는다(소급 없음)
        wage = await insertWage(m, { staffId, rate: dto.wageRate, fromDate: hiredOn < today ? today : hiredOn, reason: '입사', approvedBy: viewerId }, today);
      }
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'create','{}'::jsonb,$3::jsonb)`,
        [viewerId, staffId, JSON.stringify({ name: dto.name, role: dto.role, title: dto.title?.trim() || null, tz, hiredOn, wageRate: dto.wageRate ?? null, wageFrom: wage?.fromDate ?? null })],
      );
      return staffId;
    });
    // 만든 줄의 시급도 **볼 수 있는 사람에게만** 싣는다 — 여기서만 true 를 박으면 목록과 응답이 갈린다 (D-R39)
    // 비밀번호는 싣지 않는다 — 넘겨줄 비밀번호는 적은 화면만 안다(W10)
    return this.memberOne(id, canWage, viewerId, true);
  }

  /**
   * 구성원 한 줄 — `all()` 의 members 와 같은 모양(시급은 canWage 일 때만 · 휴대폰과 줄 플래그는 canManage 일 때만).
   * 부르는 곳은 전부 매니저 이상 경로(`@Perm('canAdminPage','canCrudAll')`)다.
   */
  private async memberOne(
    id: number, canWage: boolean, viewerId: number, canManage: boolean, canSetPerms = false,
  ): Promise<MemberDto> {
    const [r] = await this.q(
      `SELECT id, name, login_id, email, phone, role::text AS role, title, tz, active, must_change_credentials,
              to_char(hired_on,'YYYY-MM-DD') AS hired_on, ${permCols()},
              (role = 'teacher' AND active) AS wageable, (role::text = ANY($2::text[])) AS manageable
         FROM staff WHERE id = $1`,
      [id, [...STAFF_CREATE_ROLES]],
    );
    if (!r) throw staffNotFound();
    const wage = canWage ? await this.q(
      `SELECT rate, to_char(from_date,'YYYY-MM-DD') AS from_date FROM wage WHERE staff_id = $1 AND from_date <= $2::date ORDER BY from_date DESC LIMIT 1`,
      [id, todayKst()],
    ) : [];
    return {
      id: Number(r.id), name: String(r.name), loginId: String(r.login_id), email: str(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: wage[0] ? Number(wage[0].rate) : null, wageFrom: wage[0] ? String(wage[0].from_date) : null,
      wageable: canWage && r.wageable === true,
      mustChangeCredentials: r.must_change_credentials === true,
      phone: canManage ? str(r.phone) : null,
      hiredOn: str(r.hired_on),
      ...staffRowFlags(canManage, r.manageable === true, Number(r.id) === viewerId),
      canEditPerms: canManage && canSetPerms && r.manageable === true && Number(r.id) !== viewerId,
      perms: canManage ? memberPerms(r) : null,
    };
  }

  /* ══ §17 사용자 표 CRUD (W8 · 대표 지시 2026-09-26 「매니저 이상급부터 user table CRUD 가능하게」) ══════
     경로 가드는 컨트롤러의 `@Perm('canAdminPage','canCrudAll')` 이고, 여기서는 **대상 줄**을 다시 본다 —
     대표·관리자 줄은 이 길로 못 건드린다(STAFF_PROTECTED · 매니저가 대표 계정을 고치거나 가져가지 못하게).
     자기 줄은 역할 · 초기화 · 사용 중지 · 삭제가 막힌다 — 자기 계정을 스스로 잠그거나 올리는 길을 두지 않는다. */

  /** 대상 줄을 잠그고 읽는다 — 없으면 404, 강사·매니저가 아니면 403 */
  private async lockManageable(m: EntityManager, id: number): Promise<Record<string, unknown>> {
    const [row] = (await m.query(
      `SELECT id, name, login_id, email, phone, role::text AS role, title, tz, active, must_change_credentials,
              to_char(hired_on,'YYYY-MM-DD') AS hired_on, (role::text = ANY($2::text[])) AS manageable, ${permCols()}
         FROM staff WHERE id = $1 FOR UPDATE`,
      [id, [...STAFF_CREATE_ROLES]],
    )) as Array<Record<string, unknown>>;
    if (!row) throw staffNotFound();
    if (row.manageable !== true) {
      throw new ForbiddenException({ code: 'STAFF_PROTECTED', message: '대표·관리자 계정은 여기서 바꿀 수 없습니다' });
    }
    return row;
  }

  /**
   * 「수정」 — 보낸 칸만 바꾼다. 이메일을 바꾸거나 비우면 이메일 확인이, 휴대폰을 바꾸면 휴대폰 확인이 풀린다
   * (확인한 것은 **옛 값**이다). 그리고 **첫 설정을 다시 건다**(N-104 · 대표 결정 2026-09-26) — 그 사람은 다음 요청부터
   * 첫 설정 화면으로 가서 이메일 · 휴대폰을 코드로 확인하고 새 비밀번호를 정한다(가드가 요청마다 계정 행을 읽는다).
   * 확인되지 않은 연락처로 비밀번호 찾기가 가지 않게 하려는 것이다. **아이디는 연락처가 아니다**(W10) — 바꿔도 확인 · 첫 설정은
   * 그대로이고 다음 로그인부터 새 아이디로 들어온다. 기록(log)에는 바뀐 칸만 남기고 연락처(이메일 모양 아이디 포함)는 가린 모양으로만 적는다.
   */
  async updateStaff(
    viewerId: number, canWage: boolean, id: number, dto: StaffPatchDto,
    /** N-68 — 권한 예외를 적을 수 있는가(대표 판정)와 보는 사람의 결론 권한(켤 수 있는 한도) */
    perm: { canSet: boolean; viewer: PermFlags | null } = { canSet: false, viewer: null },
  ): Promise<MemberDto> {
    const phone = dto.phone === undefined ? undefined : staffPhoneOf(dto.phone);
    const loginId = dto.loginId === undefined ? undefined : staffLoginIdOf(dto.loginId);
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const row = await this.lockManageable(m, id);
      const cur: Record<string, string | null> = {
        name: str(row.name), loginId: str(row.login_id), email: str(row.email), phone: str(row.phone), title: str(row.title),
        tz: str(row.tz), role: str(row.role), hiredOn: str(row.hired_on),
      };
      const next: Record<string, string | null | undefined> = {
        name: dto.name, loginId,
        email: dto.email === undefined ? undefined : (dto.email ? normalizeEmail(dto.email) : null), phone,
        title: dto.title === undefined ? undefined : (dto.title?.trim() || null),
        tz: dto.tz?.trim(), role: dto.role, hiredOn: dto.hiredOn,
      };
      // 보낸 값 중 **지금과 다른 것만** 바꾼다 — 같은 값을 다시 보낸 칸은 바뀐 것이 아니다
      const changed: Record<string, string | null> = {};
      for (const key of Object.keys(next)) {
        const value = next[key];
        if (value !== undefined && value !== cur[key]) changed[key] = value;
      }
      /*
       * N-68 권한 예외 — 보낸 칸 중 지금과 다른 것만 바꾼다(켬 true · 끔 false · 역할 따름 null).
       * 판정 차례: 대표 판정(PERM_OVERRIDE_FORBIDDEN) → 자기 줄(SELF_ROLE · 역할과 같은 금지) → 켤 수 있는 한도(PERM_GRANT_FORBIDDEN).
       * 대표·관리자 줄은 이미 `lockManageable` 이 STAFF_PROTECTED 로 막았다.
       */
      const curPerms = overridesOfRow(row);
      const permChanged: Partial<Record<PermOverrideKey, boolean | null>> = {};
      for (const key of PERM_OVERRIDE_KEYS) {
        const value = dto.perms?.[key];
        if (value !== undefined && value !== curPerms[key]) permChanged[key] = value;
      }
      const permKeys = Object.keys(permChanged) as PermOverrideKey[];
      if (Object.keys(changed).length === 0 && permKeys.length === 0) {
        throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 항목이 없습니다' });
      }
      if ('role' in changed && id === viewerId) {
        throw new ForbiddenException({ code: 'SELF_ROLE', message: '자기 역할은 바꿀 수 없습니다 — 다른 매니저 이상에게 부탁하세요' });
      }
      if (permKeys.length > 0) {
        if (!perm.canSet) {
          throw new ForbiddenException({ code: 'PERM_OVERRIDE_FORBIDDEN', message: '사람별 권한 예외는 대표만 정합니다' });
        }
        if (id === viewerId) {
          throw new ForbiddenException({ code: 'SELF_ROLE', message: '자기 권한은 바꿀 수 없습니다 — 다른 사람에게 부탁하세요' });
        }
      }
      /*
       * 권한 한도 — 역할을 바꾸거나 예외를 켜서 대상이 **새로 얻게 될** 권한은 보는 사람도 가진 것이어야 한다
       * (없는 권한을 남에게 나눠 주지 않는다 · N-68 + W11 A' 후속 · 판정은 `permGrantIssue` 한 곳). 좁히는 쪽은 막지 않는다.
       * 보는 사람의 권한을 모르면 역할 · 예외를 바꾸지 않는다(닫힌 쪽).
       */
      if ('role' in changed || permKeys.length > 0) {
        const curRole = String(cur.role ?? '');
        const nextRole = String(changed.role ?? cur.role ?? '');
        const before = isRole(curRole) ? permsOf(curRole, curPerms) : null;
        const next = isRole(nextRole) ? permsOf(nextRole, { ...curPerms, ...permChanged }) : null;
        const grant = next && perm.viewer ? permGrantIssue(perm.viewer, before, next, permKeys) : 'canAdminPage';
        if (grant) {
          // 막힌 칸이 이 쓰기가 켠 예외 칸이면 예외 문장 · 아니면 역할을 바꾸어 얻는 칸이다
          const viaRole = 'role' in changed && isRole(nextRole) && !(permKeys as readonly string[]).includes(grant);
          throw new ForbiddenException({
            code: 'PERM_GRANT_FORBIDDEN',
            message: permGrantBlockedMessage(grant, viaRole ? { kind: 'role', role: nextRole } : { kind: 'override' }),
          });
        }
      }
      if ('tz' in changed) {
        const [known] = (await m.query(`SELECT tz FROM tzg WHERE tz = $1`, [changed.tz])) as Array<{ tz: string }>;
        if (!known) {
          throw new ConflictException({ code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요' });
        }
      }
      if ('loginId' in changed) {
        const [taken] = (await m.query(`SELECT id FROM staff WHERE lower(login_id) = lower($1) AND id <> $2`, [changed.loginId, id])) as Array<{ id: string }>;
        if (taken) throw staffLoginIdTaken();
      }
      if ('email' in changed && changed.email !== null) {
        const [taken] = (await m.query(`SELECT id FROM staff WHERE lower(email) = $1 AND id <> $2`, [changed.email, id])) as Array<{ id: string }>;
        if (taken) throw staffEmailTaken();
      }
      // 칸 이름은 이 표에서만 온다 — 보낸 글이 SQL 이 되지 않는다(값은 전부 $n)
      const COLUMN: Record<string, string> = {
        name: 'name', loginId: 'login_id', email: 'email', phone: 'phone', title: 'title', tz: 'tz', role: 'role', hiredOn: 'hired_on',
      };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, value] of Object.entries(changed)) {
        params.push(value);
        const cast = key === 'role' ? '::role_t' : key === 'hiredOn' ? '::date' : '';
        sets.push(`${COLUMN[key]} = $${params.length}${cast}`);
      }
      // 권한 예외 칸 — 칸 이름은 `PERM_OVERRIDE_COLUMN` 표에서만 온다
      for (const key of permKeys) {
        params.push(permChanged[key] ?? null);
        sets.push(`${PERM_OVERRIDE_COLUMN[key]} = $${params.length}::boolean`);
      }
      if ('email' in changed) sets.push('email_verified = false');
      if ('phone' in changed) sets.push('phone_verified = false');
      // N-104 — 연락처(이메일 · 휴대폰)가 바뀌면 첫 설정을 다시 건다. 세션은 끊지 않는다(가드가 다음 요청부터 첫 설정으로 보낸다).
      // 아이디는 연락처가 아니라서 여기에 들지 않는다(W10)
      const contactChanged = 'email' in changed || 'phone' in changed;
      if (contactChanged) sets.push('must_change_credentials = true');
      try {
        await m.query(`UPDATE staff SET ${sets.join(', ')} WHERE id = $1`, params);
      } catch (e) {
        // 동시에 같은 아이디 · 이메일로 바꾼 사람이 있으면 표의 유일 색인이 마지막에 막는다
        if ((e as { code?: string }).code === '23505') throw staffUniqueTaken(e);
        throw e;
      }
      // 이메일 모양의 아이디도 연락처다(옛 계정은 이메일이 아이디로 옮겨 와 있다) — 가린 모양으로 적는다
      const shown = (key: string, value: string | null) =>
        value === null ? null
          : key === 'email' || (key === 'loginId' && value.includes('@')) ? maskEmail(value)
            : key === 'phone' ? maskPhone(value) : value;
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(changed)) {
        before[key] = shown(key, cur[key] ?? null);
        after[key] = shown(key, value);
      }
      const log: { before: Record<string, unknown>; after: Record<string, unknown> } = { before, after };
      if (contactChanged) {
        log.before = { ...before, mustChangeCredentials: row.must_change_credentials === true };
        log.after = { ...after, mustChangeCredentials: true };
      }
      if (Object.keys(changed).length > 0) {
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'update',$3::jsonb,$4::jsonb)`,
          [viewerId, id, JSON.stringify(log.before), JSON.stringify(log.after)],
        );
      }
      // N-68 — 권한 예외는 권한 쓰기라 제 줄을 남긴다(N-73 · 같은 트랜잭션). 바뀐 칸만, 값은 켬/끔/역할 따름(null)
      if (permKeys.length > 0) {
        const permBefore: Record<string, boolean | null> = {};
        const permAfter: Record<string, boolean | null> = {};
        for (const key of permKeys) { permBefore[key] = curPerms[key]; permAfter[key] = permChanged[key] ?? null; }
        await audit(m, 'staff.perms', { actorId: viewerId, entityId: id, before: permBefore, after: permAfter });
      }
    });
    return this.memberOne(id, canWage, viewerId, true, perm.canSet);
  }

  /**
   * 「비밀번호 초기화」 — 매니저가 적은 임시 비밀번호로 바꾸고 첫 설정을 다시 건다(W10 · 답변 2026-09-26 「매니저가 직접 적기」).
   * 세션을 끊는 시각(credentials_changed_at)도 적는다 — 그 전에 받은 토큰은 인증에서 막힌다(W8-A).
   * 자기 것은 첫 설정 흐름으로 바꾼다(SELF_RESET). 응답은 그 줄(MemberDto)이고 비밀번호는 싣지 않는다.
   */
  async resetStaffPassword(viewerId: number, canWage: boolean, id: number, password: string): Promise<MemberDto> {
    if (id === viewerId) {
      throw new ForbiddenException({ code: 'SELF_RESET', message: '자기 비밀번호는 여기서 초기화하지 않습니다 — 로그인한 뒤 첫 설정 화면에서 바꾸세요' });
    }
    assertTempPassword(password);
    const hash = await bcrypt.hash(password, 10);
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const row = await this.lockManageable(m, id);
      await m.query(
        `UPDATE staff SET password_hash = $2, must_change_credentials = true, credentials_changed_at = now() WHERE id = $1`,
        [id, hash],
      );
      // 비밀번호·해시는 기록하지 않는다 — 「초기화했다」는 사실과 첫 설정 상태만 남긴다
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'password_reset',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ mustChangeCredentials: row.must_change_credentials === true }), JSON.stringify({ mustChangeCredentials: true })],
      );
    });
    return this.memberOne(id, canWage, viewerId, true);
  }

  /** 「사용 중지」·「다시 사용」 — 같은 값이면 아무것도 적지 않고 그대로 돌려준다(두 번 눌러도 같다) */
  async setStaffActive(viewerId: number, canWage: boolean, id: number, active: boolean): Promise<MemberDto> {
    if (id === viewerId) {
      throw new ForbiddenException({ code: 'SELF_ACTIVE', message: '자기 계정은 사용 중지할 수 없습니다' });
    }
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const row = await this.lockManageable(m, id);
      if ((row.active === true) === active) return;
      await m.query(`UPDATE staff SET active = $2 WHERE id = $1`, [id, active]);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,$3,$4::jsonb,$5::jsonb)`,
        [viewerId, id, active ? 'activate' : 'deactivate', JSON.stringify({ active: !active }), JSON.stringify({ active })],
      );
    });
    return this.memberOne(id, canWage, viewerId, true);
  }

  /**
   * 「삭제」 — **기록이 하나도 없는** 계정만 지운다(잘못 만든 계정을 치우는 길). 기록이 있으면 409 로 막고 사용 중지로 안내한다.
   *
   * 「기록」은 셋이다 — ① FK 가 없는 staff 칸(`STAFF_SOFT_REFS` · 시급 WAGE 포함) ② 지우면 조용히 같이 사라지거나
   * 비워질 FK(CASCADE · SET NULL — 계정 자신의 인증 코드는 뺀다) ③ NO ACTION · RESTRICT FK — DB 가 23503 으로 막는다.
   * ①②는 먼저 묻고 ③은 DB 에 맡긴다. 셋 다 같은 트랜잭션이라 막히면 **아무것도 안 사라진다.**
   */
  async deleteStaff(viewerId: number, id: number): Promise<void> {
    if (id === viewerId) {
      throw new ForbiddenException({ code: 'SELF_DELETE', message: '자기 계정은 지울 수 없습니다' });
    }
    const hasRecords = () => new ConflictException({ code: 'STAFF_HAS_RECORDS', message: '기록이 있는 구성원은 지울 수 없습니다 — 사용 중지로 막아 주세요' });
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      await this.lockManageable(m, id);
      if ((await staffRecordTables(m, id)).length > 0) throw hasRecords();
      let gone: Array<Record<string, unknown>>;
      try {
        gone = writtenRows<Record<string, unknown>>(await m.query(
          `DELETE FROM staff WHERE id = $1
           RETURNING name, role::text AS role, title, tz, active, to_char(hired_on,'YYYY-MM-DD') AS hired_on, ${kstAt('created_at')} AS created_at`,
          [id],
        ));
      } catch (e) {
        if ((e as { code?: string }).code === '23503') throw hasRecords();
        throw e;
      }
      const r = gone[0];
      if (!r) throw staffNotFound();
      // 지운 줄은 되살릴 수 없으므로 흔적을 남긴다 — 비밀번호·해시·연락처는 적지 않는다
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'delete',$3::jsonb,'{}'::jsonb)`,
        [viewerId, id, JSON.stringify({
          name: str(r.name), role: str(r.role), title: str(r.title), tz: str(r.tz),
          active: r.active === true, hiredOn: str(r.hired_on), createdAt: str(r.created_at),
        })],
      );
    });
  }

  /**
   * §15 수동 할 일 만들기. 다른 사람에게 배정하려면 canCrudAll 이어야 한다.
   *
   * W11 · N-71 — 수업 상세 「+ 할 일」은 같은 경로에 **회차 키 두 칸**(serId · onDate)을 싣는다. 그러면 출처는 수업(src=lesson)이고
   * §12 준비 줄 「대표 지시 할 일」과 §64 연결 수업 칩이 이 행을 읽는다. 수업에 거는 것은 일정 권한(canCrudAll · 수업 상세의
   * 「일정 수정」과 같은 판정)이고, 회차가 있어야 하며 휴강한 회차에는 걸지 않는다 — 단추도 같은 조건에서만 선다.
   */
  async createTodo(viewerId: number, canSeeAll: boolean, dto: TodoCreateDto): Promise<{ id: number }> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException({ code: 'TODO_TITLE_REQUIRED', message: '할 일을 적어 주세요' });
    const toId = dto.toId ?? viewerId;
    if (toId !== viewerId && !canSeeAll) {
      throw new ForbiddenException({ code: 'TODO_ASSIGN_FORBIDDEN', message: '다른 사람에게 할 일을 배정할 권한이 없습니다' });
    }
    const lesson = dto.serId != null || dto.onDate != null;
    if (lesson) {
      // 한 칸만으로는 어느 회차인지 못 짚는다 — 표의 todo_lesson_key 와 같은 말을 400 으로 먼저 한다
      if (dto.serId == null || dto.onDate == null) {
        throw new BadRequestException({ code: 'TODO_LESSON_KEY', message: '수업과 날짜를 함께 보내야 합니다' });
      }
      if (!canSeeAll) {
        throw new ForbiddenException({ code: 'TODO_LESSON_FORBIDDEN', message: '수업에 할 일을 거는 것은 일정 권한이 있는 사람만 합니다' });
      }
      const [occ] = await this.q(
        `SELECT canceled FROM ser_occ WHERE ser_id = $1 AND on_date = $2::date`, [dto.serId, dto.onDate],
      );
      if (!occ) throw new NotFoundException({ code: 'LESSON_NOT_FOUND', message: '그 회차를 찾을 수 없습니다' });
      if (occ.canceled === true) {
        throw new ConflictException({ code: 'TODO_LESSON_CANCELED', message: '휴강한 회차에는 할 일을 걸지 않습니다' });
      }
    }
    const [staff] = await this.q(`SELECT id, name FROM staff WHERE id = $1 AND active`, [toId]);
    if (!staff) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '활성 구성원을 찾을 수 없습니다' });
    const [row] = await this.q(
      `INSERT INTO todo (title, from_id, to_id, due_on, src, ser_id, on_date)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7::date) RETURNING id`,
      [title, viewerId, toId, dto.dueOn ?? null, lesson ? 'lesson' : 'manual', lesson ? dto.serId : null, lesson ? dto.onDate : null],
    );
    return { id: Number(row.id) };
  }

  /**
   * §15 「끝난 것 지우기」 — **화면이 보여 준 그것만** (대표 결정 2026-09-20 · S4).
   *
   * 전에는 `WHERE done AND ($2::boolean OR …)` 이라 `canSeeAll` 이면 조건이 **통째로 사라져**
   * 전사 하드 삭제였다. 화면의 단추는 **지금 보이는 필터**의 끝난 것 수로 열리는데(수신함/발신함/전체 ·
   * 일·주·월) 서버는 남의 것·지난 달 것까지 지웠다 — **단추의 숫자와 지워지는 수가 달랐다**(D-R39).
   *
   * 이제 화면이 세고 있는 id 를 그대로 받고, 서버는 그중 **아직 끝나 있고 이 사람이 볼 수 있는** 행만
   * 지운다. 기간·묶음 규칙을 서버에 다시 쓰지 않는다(D-R22) — 그러면 두 벌이 되어 또 갈린다.
   * 사이에 누가 체크를 풀었으면 그 줄은 안 지워지고, 응답의 `deleted` 가 실제 수다.
   *
   * **지운 것은 흔적을 남긴다** — 하드 삭제라 지운 뒤에는 무엇이 있었는지 아무도 모른다
   * (S2 의 입금 줄 삭제와 같은 자리). 같은 트랜잭션에서 `log` 한 줄에 지운 줄을 통째로 적는다.
   *
   * **상담 사후 관리(해피콜 · 월간 상담)는 지우지 않는다** (W11 A' · N-86 「완료 이력은 지우지 않는다」) — 등록 카드의
   * 「완료 03-18」이 그 줄을 읽는다. 화면은 서버 플래그 `clearable` 로 보낼 줄을 고르고, 여기서도 같은 목록을 한 번 더 뺀다.
   */
  async clearDoneTodos(viewerId: number, canSeeAll: boolean, ids: readonly number[]): Promise<number> {
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const gone = (await m.query(
        `DELETE FROM todo
          WHERE id = ANY($3::bigint[]) AND done AND ($2::boolean OR to_id = $1 OR from_id = $1)
            AND NOT (src::text = ANY($4::text[]))
          RETURNING id, title, src, to_id, from_id, to_char(due_on,'YYYY-MM-DD') AS due_on`,
        [viewerId, canSeeAll, [...ids], [...TODO_KEEP_ON_CLEAR]],
      )) as Array<Record<string, unknown>>;
      const rows = writtenRows<Record<string, unknown>>(gone);
      if (rows.length === 0) return 0;
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1,'TODO',$2,'clear',$3::jsonb,'{}'::jsonb)`,
        [
          viewerId,
          Number(rows[0]!.id),
          JSON.stringify(rows.map((r) => ({
            id: Number(r.id), title: String(r.title), src: String(r.src),
            toId: num(r.to_id), fromId: num(r.from_id), dueOn: str(r.due_on),
          }))),
        ],
      );
      return rows.length;
    });
  }

  /** §64 기한과 선택적 완료를 같은 행 잠금/감사 transaction에 저장한다. */
  async patchTodo(id: number, dto: TodoPatchDto, viewerId: number, canSeeAll: boolean): Promise<boolean> {
    if (dto.dueOn === undefined) {
      if (dto.done === undefined) throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 항목이 없습니다' });
      return this.setTodoDone(id, dto.done, viewerId, canSeeAll);
    }
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [row] = await m.query(
        `SELECT done, to_char(due_on,'YYYY-MM-DD') AS due_on FROM todo
          WHERE id=$1 AND ($3::boolean OR to_id=$2 OR from_id=$2) FOR UPDATE`,
        [id, viewerId, canSeeAll],
      ) as Array<{ done: boolean; due_on: string | null }>;
      if (!row) return false;
      const before = { done: row.done, dueOn: row.due_on };
      const after = { done: dto.done ?? row.done, dueOn: dto.dueOn };
      // 같은 값을 재전송하면 업무 변경이 없다. LOG를 늘리지 않고 성공으로 답한다.
      if (before.done === after.done && before.dueOn === after.dueOn) return true;
      const changed = await m.query(
        `UPDATE todo SET done=$2, due_on=$3::date WHERE id=$1 RETURNING id`,
        [id, after.done, after.dueOn],
      );
      if (writtenRows(changed).length === 0) return false;
      await m.query(
        `INSERT INTO log (actor_id,entity,entity_id,action,before,after)
          VALUES ($1,'TODO',$2,'update',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify(before), JSON.stringify(after)],
      );
      // W11 · N-86 — 월간 상담을 끝냈으면 다음 달 하나를 잇는다(같은 트랜잭션 · 상담 할 일이 아니면 아무것도 안 한다)
      if (after.done) await continueLeadCare(m, id, viewerId);
      return true;
    });
  }

  /**
   * §15 할 일 체크. 강사는 **자기가 주고받은 것만** 건드린다 (D-R39)
   * W11 · N-86 — 끝낸 것이 상담 **월간 상담**이면 같은 트랜잭션에서 다음 달 하나를 잇는다(`ops/lead-care` · 휴원이면 복귀 뒤 · 수강 종료면 멈춤).
   */
  async setTodoDone(id: number, done: boolean, viewerId: number, canSeeAll: boolean): Promise<boolean> {
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const rows = await m.query(
        `UPDATE todo SET done = $2
          WHERE id = $1 AND ($4::boolean OR to_id = $3 OR from_id = $3)
          RETURNING id`,
        [id, done, viewerId, canSeeAll],
      );
      if (writtenRows(rows).length === 0) return false;
      if (done) await continueLeadCare(m, id, viewerId);
      return true;
    });
  }

  /** §16 알림 읽음. 남의 알림은 읽음 처리되지 않는다 — 조용히 0건이 아니라 false 로 답한다 */
  async markNotiRead(id: number, viewerId: number): Promise<boolean> {
    const rows = await this.q(
      `UPDATE noti SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND to_id = $2 RETURNING id`,
      [id, viewerId],
    );
    return writtenRows(rows).length > 0;
  }

  /**
   * §16 「전부 읽음으로 표시」 — **내게 온 것만** 읽음으로 바꾼다.
   * 보이는 창(30일)과 무관하게 내 안 읽은 알림 전부를 처리한다 — 화면에 안 보이는 것을
   * 안 읽은 채로 남겨 두면 배지가 영영 안 내려간다. 지우지는 않는다 (N-7).
   */
  async markAllNotisRead(viewerId: number): Promise<number> {
    const rows = await this.q(
      `UPDATE noti SET read_at = now() WHERE to_id = $1 AND read_at IS NULL RETURNING id`,
      [viewerId],
    );
    return writtenRows(rows).length;
  }

  /**
   * §14 승인 대기함 — **요청(REQ) 한 줄을 처리한다.**
   *
   * 원문 §14 는 줄마다 「반려」「승인」을 갖는다. D-R27 의 「이동만」은 §75 결재 흐름
   * 오버레이의 규칙이고, D-R13(반려 사유 필수)의 절 칸에는 **14** 가 들어 있다 —
   * 반려 사유가 필수인 화면이 곧 반려하는 화면이다.
   *
   * 여기서 중요한 것은 **승인이 실제로 무언가를 바꾼다**는 것이다. 상태만 'approved' 로
   * 적어 두면 강사 화면의 시급은 그대로고, 아무도 그 사실을 모른 채 「승인했다」고 믿는다.
   *
   *   wage_change → WAGE 새 줄 (from_date = 승인일 · 소급 없음 · D8)
   *   tz_change   → STAFF.tz
   *   gpa_request → GPA 기록 한 줄(`GpaService.createUse` 그대로 · 승인 대기 wait) — N-99
   *   book_change → **상태와 알림만**(N-99) — 새 교재를 정하지 않으므로 배부는 관리자가 §38 에서 바꾼다(자동 배부 없음)
   *   그 밖        → **적용 대상이 없다.** 상태만 닫는다 — 없는 적용을 지어내지 않는다
   *
   * 처리한 본인에게는 **되돌리기 토큰**(10분 · N-84)이 돌아간다 — 무엇을 거꾸로 할지는 토큰 안의 `effect` 가 말한다.
   *
   * 잠금·적용·기록이 **한 트랜잭션**이다 (D-R43 · 원칙 26). 두 사람이 같은 줄을 동시에
   * 승인하면 뒤엣사람은 REQ_NOT_PENDING 으로 막히고 시급 줄이 두 개 생기지 않는다.
   */
  async reviewRequest(
    reqId: number, viewerId: number, dto: ReqReviewDto, canWage: boolean,
  ): Promise<{ id: number; state: string; applied: string | null; undoToken: string | null; undoExpiresAt: string | null }> {
    const approving = dto.decision === 'approve';
    const reason = dto.reason?.trim() || null;
    // 반려 사유는 **저장 전에** 막는다 — 빈 반려를 원장에 남기면 되돌릴 길이 없다 (D-R13)
    if (!approving && !reason) {
      throw new BadRequestException({
        code: 'REJECT_REASON_REQUIRED',
        message: '반려 사유를 적어 주세요 — 사유가 없으면 올린 사람이 무엇을 고쳐야 할지 모릅니다',
      });
    }
    const today = todayKst();

    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [req] = (await m.query(
        `SELECT id, staff_id, student_id, req_type, payload, state FROM req WHERE id = $1 FOR UPDATE`, [reqId],
      )) as Array<{
        id: string; staff_id: string; student_id: string | null; req_type: string; payload: Record<string, unknown> | null; state: string;
      }>;
      if (!req) throw new NotFoundException('요청을 찾을 수 없습니다');
      if (req.state !== 'pending') {
        throw new ConflictException({
          code: 'REQ_NOT_PENDING',
          message: req.state === 'approved' ? '이미 승인된 요청입니다' : '이미 반려된 요청입니다',
        });
      }
      const byId = Number(req.staff_id);
      if (byId === viewerId) {
        throw new ConflictException({
          code: 'SELF_APPROVAL_FORBIDDEN',
          message: '자기가 올린 요청은 자기가 처리할 수 없습니다',
        });
      }

      const payload = req.payload ?? {};
      let applied: string | null = null;
      /** 되돌리기가 거꾸로 할 일 — 승인이 실제로 바꾼 것 그대로 (N-84) */
      let effect: ReqUndoEffect = { kind: 'none' };

      if (approving && req.req_type === 'wage_change') {
        if (!canWage) {
          throw new ForbiddenException({
            code: 'WAGE_REVIEW_FORBIDDEN', message: '시급을 다룰 권한이 필요합니다',
          });
        }
        const rate = Number(payload.to);
        if (!Number.isInteger(rate) || rate <= 0) {
          throw new ConflictException({
            code: 'WAGE_RATE_INVALID', message: '요청에 적힌 시급을 읽을 수 없습니다 — 강사에게 다시 올려 달라고 하세요',
          });
        }
        // **소급 없음 · 같은 날 한 줄** — 규칙은 `lib/wage.insertWage` 한 곳이고 관리자 직접 수정(C97)도 같은 함수를 탄다 (D8 · D-R22)
        const made = await insertWage(m, { staffId: byId, rate, fromDate: today, reason, approvedBy: viewerId }, today);
        applied = `${reqAsked(req.req_type, payload).to} · ${today}부터`;
        effect = { kind: 'wage', wageId: made.id, staffId: byId, fromDate: made.fromDate };
      }

      if (approving && req.req_type === 'tz_change') {
        const tz = String(payload.tz ?? '');
        const [known] = (await m.query(`SELECT tz FROM tzg WHERE tz = $1`, [tz])) as Array<{ tz: string }>;
        if (!known) {
          throw new ConflictException({
            code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요',
          });
        }
        // 앞 값을 잠그고 읽어 둔다 — 되돌리기는 이 값으로 돌아간다 (N-84)
        const [prev] = (await m.query(`SELECT tz FROM staff WHERE id = $1 FOR UPDATE`, [byId])) as Array<{ tz: string | null }>;
        await m.query(`UPDATE staff SET tz = $2 WHERE id = $1`, [byId, tz]);
        applied = tz;
        effect = { kind: 'tz', staffId: byId, from: prev?.tz ?? null, to: tz };
      }

      if (approving && req.req_type === 'gpa_request') {
        // 기록 규칙(사이클 창 · 닫힌 사이클 · 서비스 · GPA 수업 여부 · 포인트 스냅숏)은 GPA 기록 함수 한 곳이다 (N-99)
        if (!this.gpa) throw new Error('GpaService 가 주입되지 않았습니다');
        const serId = Number(payload.serId);
        const onDate = payload.onDate;
        const startMin = Number(payload.startMin);
        const studentId = Number(req.student_id);
        const svcKey = typeof payload.svcKey === 'string' ? payload.svcKey : '';
        if (!Number.isSafeInteger(serId) || serId <= 0 || !isIsoDate(onDate) || !svcKey
          || !Number.isInteger(startMin) || startMin < 0 || startMin > 1439 || !Number.isSafeInteger(studentId) || studentId <= 0) {
          throw new ConflictException({
            code: 'GPA_REQUEST_INVALID', message: '요청에 적힌 회차를 읽을 수 없습니다 — 강사에게 다시 올려 달라고 하세요',
          });
        }
        const [cycle] = (await m.query(
          `SELECT id FROM gpa_cycle WHERE from_date <= $1::date AND to_date >= $1::date ORDER BY from_date DESC, id DESC LIMIT 1`,
          [onDate],
        )) as Array<{ id: string }>;
        if (!cycle) {
          throw new ConflictException({
            code: 'GPA_CYCLE_NONE', message: `${onDate} 을 품는 GPA 사이클이 없습니다 — GPA 관리에서 사이클을 먼저 여세요`,
          });
        }
        const use = await this.gpa.createUse(
          byId, { cycleId: Number(cycle.id), studentId, svcKey, onDate, startMin, serId }, m,
        );
        applied = `GPA 기록 ${use.points}p · ${reqAskedLine(req.req_type, payload) ?? onDate}`;
        effect = { kind: 'gpa', useId: use.id };
      }

      await m.query(
        `UPDATE req SET state = $2, resolved_by = $3, reject_reason = $4 WHERE id = $1`,
        [reqId, approving ? 'approved' : 'rejected', viewerId, approving ? null : reason],
      );

      const label = labelOf(REQ_TYPE_LABEL, req.req_type);
      /*
       * 감사 줄은 표의 이름으로(`request.review` → REQ · W11 A' 후속 · 리드 결정). 낱말(approve · reject)은 예전 그대로다.
       * 옛 줄(소문자 `req`)은 고치지 않는다(N-25) — 이제부터의 결재 · 되돌리기 줄이 같은 대문자 이름을 쓴다.
       */
      await audit(m, 'request.review', {
        actorId: viewerId, entityId: reqId, action: approving ? 'approve' : 'reject',
        before: { state: 'pending' },
        after: { state: approving ? 'approved' : 'rejected', applied, reason },
      });
      const logId = await lastApprovalLogId((sql, p) => m.query(sql, p), 'request.review', reqId);
      // 올린 사람은 결과를 알아야 한다 — 분류는 NOTI.category에 명시한다 (§16).
      // 제목은 §16 카드의 굵은 한 줄이다(g2 16-1) — 본문은 예전 그대로 두어 다른 읽는 자리가 바뀌지 않는다
      await m.query(
        `INSERT INTO noti (to_id, from_id, title, body, link, category) VALUES ($1, $2, $3, $4, $5, 'request')`,
        [byId, viewerId,
          `${label} 요청 ${approving ? '승인' : '반려'}`,
          approving
            ? `${label} 요청이 승인됐습니다${applied ? ` — ${applied}` : ''}`
            : `${label} 요청이 반려됐습니다 — ${reason}`,
          '/teacher?req'],
      );

      const undo = issueApprovalUndo(viewerId, {
        target: 'req', id: reqId, decision: approving ? 'approve' : 'reject', logId, effect,
      });
      return {
        id: reqId, state: approving ? 'approved' : 'rejected', applied,
        undoToken: undo.token, undoExpiresAt: undo.expiresAt,
      };
    });
  }

  /**
   * §20 **변경 요청 반영·반려** (C42).
   *
   * 원문 §20 의 안내가 이 함수의 계약이다 — 「겹치면 넣을 수 없습니다 ·
   * **반영하면 시간표가 바뀌고 이력에 남습니다**」. 그래서 반영은 상태를 적는 일이 아니라
   * **기존 일정 쓰기를 그대로 타는 일**이다. 규칙(3범위·겹침·참조)을 여기서 다시 쓰면
   * `recurrence.spec.ts` 가 지키지 않는 두 번째 구현이 생긴다.
   *
   * 시간표를 바꾸는 것과 요청을 닫는 것은 **한 트랜잭션**이다(`inside`). 나뉘면
   * 「시간표는 바뀌었는데 요청은 대기」가 남고 다시 누르면 두 번 반영된다. 겹쳐서
   * EXCLUDE 가 23P01 을 던지면 요청도 함께 `pending` 으로 되돌아간다.
   */
  async reviewChangeRequest(
    chreqId: number, viewerId: number, dto: ChreqReviewDto,
    /** 시간표를 쓸 수 있는가(`canCrudAll`) — 반영 · 반려 모두 시간표 관리다. 결재 권한만으로는 403 (P1 CROSS-CUT) */
    canWriteSchedule: boolean,
  ): Promise<{ id: number; state: string; applied: string | null; undoToken: string | null; undoExpiresAt: string | null }> {
    if (!canWriteSchedule) {
      throw new ForbiddenException({ code: 'CHREQ_REVIEW_FORBIDDEN', message: CHREQ_REVIEW_FORBIDDEN_MESSAGE });
    }
    const approving = dto.decision === 'approve';
    const reason = dto.reason?.trim() || null;
    if (!approving && !reason) {
      throw new BadRequestException({
        code: 'REJECT_REASON_REQUIRED',
        message: '반려 사유를 적어 주세요 — 사유가 없으면 올린 사람이 무엇을 고쳐야 할지 모릅니다',
      });
    }

    const [req] = await this.q<{
      id: string; ser_id: string; on_date: string; req_type: string;
      payload: Record<string, unknown>; state: string; by_id: string; apply_all: boolean;
      teacher_name: string | null; room_name: string | null; zacc_label: string | null;
    }>(
      `SELECT c.id, c.ser_id, to_char(c.on_date,'YYYY-MM-DD') AS on_date, c.req_type, c.payload,
              c.state, c.by_id, c.apply_all,
              t.name AS teacher_name, rm.name AS room_name, z.label AS zacc_label
         FROM chreq c
         LEFT JOIN staff t ON t.id = (c.payload->>'teacherId')::bigint
         LEFT JOIN room rm ON rm.id = (c.payload->>'roomId')::bigint
         LEFT JOIN zacc z ON z.id = (c.payload->>'zaccId')::bigint
        WHERE c.id = $1`, [chreqId],
    );
    if (!req) throw new NotFoundException('변경 요청을 찾을 수 없습니다');
    if (req.state !== 'pending') {
      throw new ConflictException({
        code: 'CHREQ_NOT_PENDING',
        message: req.state === 'approved' ? '이미 반영된 요청입니다' : '이미 반려된 요청입니다',
      });
    }
    if (Number(req.by_id) === viewerId) {
      throw new ConflictException({
        code: 'SELF_APPROVAL_FORBIDDEN', message: '자기가 올린 요청은 자기가 처리할 수 없습니다',
      });
    }

    const asked = chreqAsked(req.req_type, req.payload, {
      teacherName: req.teacher_name, roomName: req.room_name, zaccLabel: req.zacc_label,
    });

    /** 이 처리가 남긴 감사 줄 — 되돌리기 토큰이 여기에 묶인다(한 번만 · N-84) */
    let logId = 0;
    /** 요청을 닫고 이력을 남긴다 — 반영이면 **일정 쓰기와 같은 트랜잭션 안**에서 돈다 */
    const close = async (run: Run) => {
      const done = await run(
        `UPDATE chreq SET state = $2, resolved_by = $3, resolved_at = now(), reject_reason = $4
          WHERE id = $1 AND state = 'pending' RETURNING id`,
        [chreqId, approving ? 'approved' : 'rejected', viewerId, approving ? null : reason],
      );
      // 잠깐 사이에 남이 처리했다면 **여기서 멈춘다** — 반영 중이면 트랜잭션째 되돌아간다
      if (writtenRows(done).length === 0) {
        throw new ConflictException({ code: 'CHREQ_NOT_PENDING', message: '이미 처리된 요청입니다' });
      }
      // 감사 줄은 표의 이름으로(`change_request.review` → CHREQ · W11 A' 후속) — 낱말(apply · reject)은 예전 그대로다
      await audit({ query: run }, 'change_request.review', {
        actorId: viewerId, entityId: chreqId, action: approving ? 'apply' : 'reject',
        before: { state: 'pending' },
        after: { state: approving ? 'approved' : 'rejected', asked, reason },
      });
      logId = await lastApprovalLogId(run, 'change_request.review', chreqId);
      await run(
        `INSERT INTO noti (to_id, from_id, title, body, link, category) VALUES ($1, $2, $3, $4, $5, 'schedule')`,
        [Number(req.by_id), viewerId,
          `변경 요청 ${approving ? '반영' : '반려'}`,
          approving
            ? `변경 요청이 반영됐습니다 — ${asked ?? '시간표가 바뀌었습니다'}`
            : `변경 요청이 반려됐습니다 — ${reason}`,
          '/schedule'],
      );
    };

    if (!approving) {
      await this.anyRepo.manager.transaction(async (m: EntityManager) => {
        await m.query(`SELECT id FROM chreq WHERE id = $1 FOR UPDATE`, [chreqId]);
        await close((sql, p) => m.query(sql, p));
      });
      // 반려 되돌리기는 **상태만**이다 (N-84) — 시간표는 바뀐 적이 없다
      const undo = issueApprovalUndo(viewerId, { target: 'chreq', id: chreqId, decision: 'reject', logId, schedToken: null });
      return { id: chreqId, state: 'rejected', applied: null, undoToken: undo.token, undoExpiresAt: undo.expiresAt };
    }

    if (!chreqApplicable(req.req_type, req.payload)) {
      throw new ConflictException({
        code: 'CHREQ_NOT_APPLICABLE',
        message: '아직 반영 경로가 없는 요청입니다',
      });
    }
    if (!this.schedWrite) throw new Error('ScheduleWriteService 가 주입되지 않았습니다');

    const serId = Number(req.ser_id);
    // ERD 주석 그대로 — apply_all 은 「선택 회차부터 **이후 전체**」다 (D-R16)
    const scope = req.apply_all ? 'future' : 'this';
    const inside = async (q: QueryRunner) => {
      await q.query(`SELECT id FROM chreq WHERE id = $1 FOR UPDATE`, [chreqId]);
      await close((sql, p) => q.query(sql, p));
    };

    /* 줌 갈래 — 강의실이 아니라 **줌 계정**을 바꾸는 요청이다 (payload 에 zaccId 가 있다).
       배정 경로를 그대로 타고, 배정과 요청 종결이 **한 트랜잭션**이라 겹쳐서 막히면
       요청도 pending 으로 되돌아간다. 전에는 경로가 없어 이 갈래만 막혀 있었다 (C48 이 열었다).

       **되돌리기 (W11 A' 후속 · N-84 「모든 처리는 되돌리기로 취소됩니다」)** — 줌 배정의 정본(`zassign`)은 규칙 상태(State)의
       `zaccId` 로 실려 다니고(N-56) 일정 쓰기의 저장(persist)이 그 칸을 `zassign` 에 맞춘다. 그래서 배정 **앞뒤의 규칙 상태**로
       일정 되돌리기 토큰을 만들면 되돌리기가 **앞 배정으로** 돌아간다(배정 때 만든 예외 줄도 함께 걷힌다). 그 사이 같은 규칙에
       무엇이든 바뀌었으면(다른 배정 포함) 일정 되돌리기의 신선도 판정이 409 로 멈춘다 — 「그 사이 다른 배정이 없을 때만」이다. */
    const p0 = (req.payload ?? {}) as Record<string, unknown>;
    if (req.req_type === 'room' && p0.zaccId !== undefined) {
      if (!this.zoom) throw new Error('ZoomService 가 주입되지 않았습니다');
      let sched: { token: string; expiresAt: string } | null = null;
      await this.anyRepo.manager.transaction(async (m: EntityManager) => {
        const q = m.queryRunner as QueryRunner;
        // 배정 앞 상태 — 일정 쓰기와 같은 부모 잠금(SER)을 먼저 잡는다(assignIn 도 같은 잠금을 다시 잡는다)
        const before = await loadState(q, [serId], { forWrite: true });
        await this.zoom!.assignIn(m, viewerId, {
          serId,
          // apply_all 이면 규칙 전체, 아니면 그 회차만 (D-R16 과 같은 뜻)
          onDate: req.apply_all ? undefined : req.on_date,
          zaccId: Number(p0.zaccId),
        });
        // 일반 일정 승인처럼 SER→CHREQ 순서다. 먼저 처리됐으면 close의 pending CAS가 전부 되돌린다.
        await m.query(`SELECT id FROM chreq WHERE id = $1 FOR UPDATE`, [chreqId]);
        await close((sql, p) => m.query(sql, p));
        sched = issueScheduleUndoStep(viewerId, before, await loadState(q, [serId]));
      });
      const made = sched as { token: string; expiresAt: string } | null;
      const undo = made
        ? issueApprovalUndo(viewerId, { target: 'chreq', id: chreqId, decision: 'approve', logId, schedToken: made.token }, Date.now(), made.expiresAt)
        : null;
      return { id: chreqId, state: 'approved', applied: asked, undoToken: undo?.token ?? null, undoExpiresAt: undo?.expiresAt ?? null };
    }

    /*
     * 반영은 **처리한 사람의 이름으로** 일정 쓰기를 탄다(actorId) — 그래야 일정 되돌리기 토큰이 나오고(N-84 「일정 되돌리기
     * 토큰을 그대로」), 휴강 알림의 보낸 이가 처리한 사람이 된다(자기에게는 가지 않는다 · 직접 휴강과 같다).
     */
    let written: { undoToken?: string | null; undoExpiresAt?: string | null };
    if (req.req_type === 'cancel') {
      written = await this.schedWrite.remove(serId, { scope, onDate: req.on_date }, inside, viewerId);
    } else {
      const p = req.payload ?? {};
      const patch: Record<string, unknown> = { scope, onDate: req.on_date };
      if (req.req_type === 'time_move') {
        patch.startMin = Number(p.startMin); patch.endMin = Number(p.endMin);
      } else if (req.req_type === 'teacher') {
        patch.teacherId = Number(p.teacherId);
      } else {
        patch.roomId = Number(p.roomId);
      }
      written = await this.schedWrite.patch(serId, patch as never, inside, viewerId);
    }
    const schedToken = written.undoToken ?? null;
    const undo = schedToken
      ? issueApprovalUndo(viewerId, { target: 'chreq', id: chreqId, decision: 'approve', logId, schedToken }, Date.now(), written.undoExpiresAt)
      : null;
    return { id: chreqId, state: 'approved', applied: asked, undoToken: undo?.token ?? null, undoExpiresAt: undo?.expiresAt ?? null };
  }

  /* ══ N-84 결재 되돌리기 — 원문 §14 머리 「모든 처리는 되돌리기로 취소됩니다」 ═══════════════════════
     본인 · 10분 · 그 처리 하나. 토큰이 무엇을 거꾸로 할지 말하고, 서버는 **그 사이 바뀐 것이 없는지**(신선도)를 본 뒤에만
     되돌린다. 이미 간 알림은 지우지도 새로 짓지도 않는다(N-55 ②). LOG 는 한 줄(`approval.undo` · `approval.undo_chreq`). */

  async undoApproval(
    actorId: number, token: string, canWage: boolean,
    /** 변경 요청 처리의 되돌리기는 시간표를 되돌리는 쓰기다 — 처리와 같은 권한(`canCrudAll`)이 있어야 한다 (P1 CROSS-CUT) */
    canWriteSchedule: boolean,
  ): Promise<ApprovalUndoResultDto> {
    const p = readApprovalUndo(token, actorId);
    if (!p) {
      throw new BadRequestException({ code: 'BAD_UNDO_TOKEN', message: '되돌리기 시간이 지났거나 토큰이 올바르지 않습니다' });
    }
    if (p.target === 'chreq' && !canWriteSchedule) {
      throw new ForbiddenException({ code: 'CHREQ_REVIEW_FORBIDDEN', message: CHREQ_REVIEW_FORBIDDEN_MESSAGE });
    }
    return p.target === 'req' ? this.undoReq(p, actorId, canWage) : this.undoChreq(p, actorId);
  }

  private undoReq(
    p: Extract<ApprovalUndoPayload, { target: 'req' }>, actorId: number, canWage: boolean,
  ): Promise<ApprovalUndoResultDto> {
    const stale = (message: string) => new ConflictException({ code: 'UNDO_STALE', message });
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [req] = (await m.query(
        `SELECT id, staff_id, state, resolved_by, reject_reason FROM req WHERE id = $1 FOR UPDATE`, [p.id],
      )) as Array<{ id: string; staff_id: string; state: string; resolved_by: string | null; reject_reason: string | null }>;
      if (!req) throw new NotFoundException('요청을 찾을 수 없습니다');
      const decided = p.decision === 'approve' ? 'approved' : 'rejected';
      // 「직전 하나」 — 그 뒤 누가 다시 처리했으면(되돌리고 다시 처리 포함) 이 토큰의 처리는 이미 지난 일이다
      if (req.state !== decided || Number(req.resolved_by) !== actorId) {
        throw stale('그 뒤 이 요청이 다시 처리되어 되돌릴 수 없습니다');
      }
      // 한 번만 — 같은 사람이 되돌린 뒤 같은 결정으로 다시 처리하면 상태는 같다. 토큰이 묶인 감사 줄이 마지막인지로 가른다
      if (!(await approvalLogIsLast((sql, prm) => m.query(sql, prm), auditEntityOf('request.review'), p.id, p.logId))) {
        throw stale('그 뒤 이 요청이 다시 처리되어 되돌릴 수 없습니다');
      }
      const e = p.effect;
      let reverted = '상태만';
      if (e.kind === 'wage') {
        // 시급 줄은 돈이다 — 승인할 때와 같은 권한이 필요하다
        if (!canWage) throw new ForbiddenException({ code: 'WAGE_REVIEW_FORBIDDEN', message: '시급을 다룰 권한이 필요합니다' });
        const [w] = (await m.query(
          `SELECT id, staff_id, to_char(from_date,'YYYY-MM-DD') AS from_date FROM wage WHERE id = $1 FOR UPDATE`, [e.wageId],
        )) as Array<{ id: string; staff_id: string; from_date: string }>;
        if (!w || Number(w.staff_id) !== e.staffId || w.from_date !== e.fromDate || Number(req.staff_id) !== e.staffId) {
          throw stale('그 승인이 넣은 시급 줄이 이미 없습니다');
        }
        // 그 승인이 넣은 줄이 **여전히 마지막 줄**일 때만 — 뒤에 줄이 더 있으면 지우는 순간 그 사이의 시급이 바뀐다(소급 없음 · D8)
        const [later] = (await m.query(
          `SELECT id FROM wage WHERE staff_id = $1 AND from_date > $2::date LIMIT 1`, [e.staffId, e.fromDate],
        )) as Array<{ id: string }>;
        if (later) throw stale('그 뒤 시급 줄이 더 생겨 되돌릴 수 없습니다 — 되돌리기는 마지막 줄만 지웁니다');
        // 어떤 지급 확정에도 쓰이지 않았을 때만 — 오늘 시작한 줄이라 확정 달과 겹칠 일이 없지만 표로 한 번 더 확인한다
        const [paid] = (await m.query(
          `SELECT year_month FROM payout
            WHERE staff_id = $1 AND ${payoutConfirmedSql()} AND year_month >= to_char($2::date, 'YYYY-MM') LIMIT 1`,
          [e.staffId, e.fromDate],
        )) as Array<{ year_month: string }>;
        if (paid) {
          throw new ConflictException({
            code: 'UNDO_PAYOUT_CONFIRMED', message: `${paid.year_month} 정산이 이미 확정되어 그 시급 줄을 지울 수 없습니다`,
          });
        }
        await m.query(`DELETE FROM wage WHERE id = $1`, [e.wageId]);
        reverted = '시급 줄 삭제';
      } else if (e.kind === 'tz') {
        const [st] = (await m.query(`SELECT tz FROM staff WHERE id = $1 FOR UPDATE`, [e.staffId])) as Array<{ tz: string | null }>;
        if (!st || st.tz !== e.to) throw stale('그 뒤 시간대가 다시 바뀌어 되돌릴 수 없습니다');
        await m.query(`UPDATE staff SET tz = $2 WHERE id = $1`, [e.staffId, e.from]);
        reverted = '시간대 되돌림';
      } else if (e.kind === 'gpa') {
        const [use] = (await m.query(
          `SELECT id, state, cycle_id FROM gpa_use WHERE id = $1 FOR UPDATE`, [e.useId],
        )) as Array<{ id: string; state: string; cycle_id: string }>;
        if (!use) throw stale('그 승인이 넣은 GPA 기록이 이미 없습니다');
        if (use.state !== 'wait') throw stale('그 GPA 기록이 이미 승인되어 되돌릴 수 없습니다 — GPA 관리에서 먼저 되돌리세요');
        // GPA 쓰기와 같은 차례 — 대상 줄 FOR UPDATE → 사이클 FOR SHARE (마감과 엇갈리지 않게)
        const [cycle] = (await m.query(
          `SELECT closed FROM gpa_cycle WHERE id = $1 FOR SHARE`, [use.cycle_id],
        )) as Array<{ closed: boolean }>;
        if (!cycle || cycle.closed) {
          throw new ConflictException({ code: 'CYCLE_CLOSED', message: '닫힌 사이클입니다 — 잔여는 소멸했고 기록을 바꿀 수 없습니다' });
        }
        await m.query(`DELETE FROM gpa_use WHERE id = $1`, [e.useId]);
        reverted = 'GPA 기록 삭제';
      }
      await m.query(`UPDATE req SET state = 'pending', resolved_by = NULL, reject_reason = NULL WHERE id = $1`, [p.id]);
      await audit(m, 'approval.undo', {
        actorId, entityId: p.id,
        before: { state: decided, rejectReason: req.reject_reason, effect: e.kind },
        after: { state: 'pending', reverted },
      });
      return { id: p.id, target: 'req' as const, state: 'pending' as const, reverted };
    });
  }

  private async undoChreq(p: Extract<ApprovalUndoPayload, { target: 'chreq' }>, actorId: number): Promise<ApprovalUndoResultDto> {
    const decided = p.decision === 'approve' ? 'approved' : 'rejected';
    /** 요청을 다시 대기로 — 반영 되돌리기면 **일정 되돌리기와 같은 트랜잭션** 안에서 돈다 */
    const reopen = async (run: Run, reverted: string) => {
      const [row] = (await run(
        `SELECT id, state, resolved_by, reject_reason FROM chreq WHERE id = $1 FOR UPDATE`, [p.id],
      )) as Array<{ id: string; state: string; resolved_by: string | null; reject_reason: string | null }>;
      if (!row) throw new NotFoundException('변경 요청을 찾을 수 없습니다');
      // 상태가 같아도(되돌리고 같은 결정으로 다시 처리) 토큰이 묶인 감사 줄 뒤에 줄이 있으면 지난 일이다 — 한 번만
      if (row.state !== decided || Number(row.resolved_by) !== actorId
        || !(await approvalLogIsLast(run, auditEntityOf('change_request.review'), p.id, p.logId))) {
        throw new ConflictException({ code: 'UNDO_STALE', message: '그 뒤 이 변경 요청이 다시 처리되어 되돌릴 수 없습니다' });
      }
      await run(
        `UPDATE chreq SET state = 'pending', resolved_by = NULL, resolved_at = NULL, reject_reason = NULL WHERE id = $1`, [p.id],
      );
      await audit({ query: run }, 'approval.undo_chreq', {
        actorId, entityId: p.id,
        before: { state: decided, rejectReason: row.reject_reason },
        after: { state: 'pending', reverted },
      });
    };

    if (p.decision === 'reject') {
      await this.anyRepo.manager.transaction((m: EntityManager) => reopen((sql, params) => m.query(sql, params), '상태만'));
      return { id: p.id, target: 'chreq', state: 'pending', reverted: '상태만' };
    }
    if (!p.schedToken) {
      throw new BadRequestException({ code: 'BAD_UNDO_TOKEN', message: '되돌리기 시간이 지났거나 토큰이 올바르지 않습니다' });
    }
    if (!this.schedWrite) throw new Error('ScheduleWriteService 가 주입되지 않았습니다');
    // 줌 갈래도 같은 길이다 — 배정은 규칙 상태의 칸이라 일정 되돌리기가 앞 배정으로 돌린다(W11 A' 후속). 낱말만 다르다
    const [kind] = await this.q<{ zoom: boolean }>(
      `SELECT (req_type = 'room' AND payload IS NOT NULL AND jsonb_exists(payload, 'zaccId')) AS zoom FROM chreq WHERE id = $1`, [p.id],
    );
    const reverted = kind?.zoom === true ? '줌 계정 되돌림' : '시간표 되돌림';
    // 시간표는 **일정 되돌리기 토큰 그대로** 되돌린다 — 신선도(그 사이 같은 수업이 또 바뀌었나) · 참조 판정도 그 함수가 한다
    await this.schedWrite.undo(actorId, p.schedToken, (q: QueryRunner) => reopen((sql, params) => q.query(sql, params), reverted));
    return { id: p.id, target: 'chreq', state: 'pending', reverted };
  }

  /* ══ §20 「최근 변경 이력」 (W11 A' 후속 · N-73 의 읽는 쪽) ═══════════════════════════════════════════
     원천은 스케줄 감사 줄(`log` entity SER · 규칙 하나의 쓰기 한 번)이다 — 원문 슬라이드 20 데이터 줄 「반영 시 EXC 생성, LOG 기록」.
     볼 수 있는 범위는 §20 목록과 같다: 전체 권한(canCrudAll)이면 모두, 아니면 **내가 한 것**만(목록의 「내가 올린 것」과 같은 모양).
     문장은 `lib/schedule-history` 한 곳이 만든다 — 이름(강사 · 강의실 · 학생)만 여기서 읽어 넘긴다. 줌 배정은 원장에 없다(비밀 값도). */
  async scheduleHistory(viewerId: number, canSeeAll: boolean, beforeId?: number): Promise<ScheduleHistoryDto> {
    const rows = await this.q(
      `SELECT l.id, l.entity_id, l.action, l.before, l.after, ${kstAt('l.at')} AS at, a.name AS actor_name,
              s.title, sb.name AS sub_name, k.name AS kind_name
         FROM log l
         LEFT JOIN staff a ON a.id = l.actor_id
         LEFT JOIN ser s ON s.id = l.entity_id
         LEFT JOIN sub sb ON sb.key = s.sub_key
         LEFT JOIN kind k ON k.key = s.kind_key
        WHERE l.entity = $3 AND ($2::boolean OR l.actor_id = $1)
          AND ($4::bigint IS NULL OR l.id < $4)
        ORDER BY l.id DESC LIMIT 21`,
      [viewerId, canSeeAll, auditEntityOf('schedule.patch'), beforeId ?? null],
    );
    const page = rows.slice(0, 20);
    // 이름 재료 — 줄의 앞뒤에 적힌 번호만 모아 한 번씩 읽는다
    const teachers = new Set<number>();
    const rooms = new Set<number>();
    const students = new Set<number>();
    const subs = new Set<string>();
    const kinds = new Set<string>();
    const collect = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (typeof o.teacherId === 'number') teachers.add(o.teacherId);
      if (typeof o.roomId === 'number') rooms.add(o.roomId);
      if (typeof o.sub === 'string') subs.add(o.sub);
      if (typeof o.kind === 'string') kinds.add(o.kind);
      if (Array.isArray(o.roster)) {
        for (const r of o.roster) if (r && typeof (r as R).studentId === 'number') students.add((r as R).studentId as number);
      }
      if (o.exc && typeof o.exc === 'object') {
        for (const e of Object.values(o.exc as R)) {
          if (!e || typeof e !== 'object') continue;
          const x = e as R;
          if (typeof x.teacherId === 'number') teachers.add(x.teacherId);
          if (typeof x.roomId === 'number') rooms.add(x.roomId);
        }
      }
    };
    for (const r of page) { collect(r.before); collect(r.after); }
    const nameMap = async (sql: string, keys: Array<number | string>): Promise<Map<string, string>> =>
      keys.length === 0 ? new Map()
        : new Map((await this.q<{ k: string; name: string }>(sql, [keys])).map((x) => [String(x.k), String(x.name)]));
    const [tNames, rNames, sNames, subNames, kindNames] = await Promise.all([
      nameMap(`SELECT id::text AS k, name FROM staff WHERE id = ANY($1::bigint[])`, [...teachers]),
      nameMap(`SELECT id::text AS k, name FROM room WHERE id = ANY($1::bigint[])`, [...rooms]),
      nameMap(`SELECT id::text AS k, name FROM stu WHERE id = ANY($1::bigint[])`, [...students]),
      nameMap(`SELECT key AS k, name FROM sub WHERE key = ANY($1::text[])`, [...subs]),
      nameMap(`SELECT key AS k, name FROM kind WHERE key = ANY($1::text[])`, [...kinds]),
    ]);
    const names = {
      teacher: (id: number) => tNames.get(String(id)) ?? null,
      room: (id: number) => rNames.get(String(id)) ?? null,
      student: (id: number) => sNames.get(String(id)) ?? null,
    };
    /**
     * 규칙의 사람 이름 — 다른 서버 문장과 같은 순서(과목 → 제목 → 종류 · 겹침 문장 · 강사 교체 · 원문 「SAT Reading」).
     * 지금 표에 없으면(지운 규칙) 줄의 앞뒤에서 찾는다. 빈 제목은 없는 제목이다
     */
    const nameOf = (r: R): string => {
      const view = (r.after ?? r.before ?? {}) as R;
      const sub = str(r.sub_name) ?? (typeof view.sub === 'string' ? subNames.get(view.sub) ?? null : null);
      const title = (str(r.title) ?? (typeof view.title === 'string' ? view.title : null))?.trim() || null;
      const kind = str(r.kind_name) ?? (typeof view.kind === 'string' ? kindNames.get(view.kind) ?? null : null);
      return sub ?? title ?? kind ?? '수업';
    };
    const preferredDate = (r: R): string | null => {
      for (const value of [r.after, r.before]) {
        if (!value || typeof value !== 'object') continue;
        const view = value as R;
        if (view.exc && typeof view.exc === 'object') {
          const [day] = Object.keys(view.exc as R).sort();
          if (isIsoDate(day)) return day;
        }
        if (typeof view.fromDate === 'string' && isIsoDate(view.fromDate)) return view.fromDate;
      }
      return null;
    };
    // 줄에서 여는 주소는 실제 투영에 남아 있는 회차만 준다. 지운 규칙을 닮은 주소를 화면이 만들지 않는다.
    const targets = page.map((r) => ({ logId: Number(r.id), serId: Number(r.entity_id), wanted: preferredDate(r) }));
    const occurrenceRows = targets.length === 0 ? [] : await this.q<{ log_id: string; ser_id: string; on_date: string; drawn_on: string }>(
      `WITH target(log_id, ser_id, wanted) AS (
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::date[])
       )
       SELECT DISTINCT ON (t.log_id) t.log_id, o.ser_id, o.on_date::text AS on_date,
              (${kstDateOf('lower(o.span)')})::text AS drawn_on
         FROM target t
         JOIN ser_occ o ON o.ser_id = t.ser_id
        ORDER BY t.log_id,
                 CASE WHEN t.wanted IS NOT NULL AND o.on_date = t.wanted THEN 0 ELSE 1 END,
                 o.canceled, abs(o.on_date - current_date), o.on_date`,
      [targets.map((t) => t.logId), targets.map((t) => t.serId), targets.map((t) => t.wanted)],
    );
    const goByLog = new Map(occurrenceRows.map((o) => [Number(o.log_id),
      `/schedule?date=${o.drawn_on}&serId=${Number(o.ser_id)}&onDate=${o.on_date}`]));
    return {
      rows: page.map((r) => {
        const line = scheduleHistoryLine({ action: String(r.action), before: r.before, after: r.after, name: nameOf(r) }, names);
        return { id: Number(r.id), at: String(r.at), actorName: str(r.actor_name), ...line, go: goByLog.get(Number(r.id)) ?? null };
      }),
      nextBeforeId: rows.length > 20 ? Number(page.at(-1)!.id) : null,
    };
  }

  /** §19 변경 요청 넣기 — 겹침 판정은 부르는 쪽(컨트롤러)이 스케줄에서 받아 온다 */
  async createChangeReq(byId: number, d: NormalizedChangeRequest): Promise<number> {
    const rows = await this.q<{ id: string }>(
      // 상태는 **적지 않는다** — 표의 기본값('pending')이 낱말의 출처다.
      // 여기에 낱말을 다시 적으면 기본값이 바뀌는 날 두 곳이 갈린다.
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id, apply_all)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [d.serId, d.onDate, d.reqType, JSON.stringify(d.payload), d.reason, byId, d.applyAll],
    );
    return Number(rows[0].id);
  }

  /** JSONB 대상 id는 FK로 보호할 수 없으므로 허용된 표만 여기서 조회한다. */
  async activeChangeTargetExists(kind: 'teacher' | 'room' | 'zoom', id: number): Promise<boolean> {
    const table = { teacher: 'staff', room: 'room', zoom: 'zacc' }[kind];
    const rows = await this.q<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id=$1 AND active) AS found`,
      [id],
    );
    return rows[0]?.found === true;
  }

  /**
   * 겹침을 볼 때 필요한 회차의 시각·자원 — 요청서에 안 적힌 것은 원본에서 가져온다.
   *
   * `onDate` 는 규칙이 찍은 날(EXC 키)이라 **옮긴 회차는 실제로 놓인 날과 다르다**. 겹침은 달력 위의
   * 자리를 보는 일이므로 그 회차가 놓인 KST 날짜(`date`)를 함께 준다 — 스케줄 `conflicts()` 가 받는 날이
   * 그것이다(C84-b 가 적어 둔 키 ↔ 달력 구분 · README 7-3 「변경 요청 겹침 미리보기」 관찰).
   */
  async occOf(serId: number, onDate: string): Promise<{
    startMin: number; endMin: number; teacherId: number | null; roomId: number | null; zaccId: number | null;
    date: string;
  } | null> {
    const rows = await this.q(
      `SELECT ${START_MIN} AS start_min, ${END_MIN} AS end_min,
              o.teacher_id, o.room_id, o.zacc_id,
              to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS placed_on
         FROM ser_occ o WHERE o.ser_id = $1 AND o.on_date = $2 LIMIT 1`,
      [serId, onDate],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      startMin: Number(r.start_min), endMin: Number(r.end_min),
      teacherId: num(r.teacher_id), roomId: num(r.room_id), zaccId: num(r.zacc_id),
      date: String(r.placed_on),
    };
  }
}
