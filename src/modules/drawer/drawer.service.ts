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
import type { ApprovalFlowScope } from '../../common/perm';
import {
  apFlow, approvalFlowProjection, labelOf, reqAsked, reqAskedLine, requesterReason, toApState,
  GPAPACK_TYPE_LABEL, REQ_TYPE_LABEL, RPT_TYPE_LABEL, type ApRow,
} from '../../lib/approval';
import { kindGroupLabel } from '../../lib/catalog-words';
import { chreqApplicable, chreqAsked, isChreqType, type NormalizedChangeRequest } from '../../lib/change-request';
import { ZoomService } from '../zoom/zoom.service';
import { NOTI_CATEGORIES, NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory, notiTone } from '../../lib/noti';
import { groupByRole, roleLabel } from '../../lib/role-words';
import { START_MIN, END_MIN, kstAt, kstDateOf, writtenRows } from '../../lib/sql';
import { todoSourceLabel } from '../../lib/todo';
import { KST, overdueDays, todayKst } from '../../lib/kst';
import { insertWage } from '../../lib/wage';
import { INITIAL_PASSWORD, normalizeLoginEmail, normalizeMobile } from '../../lib/account-policy';
import { staffRecordTables } from '../../lib/staff-refs';
import { maskEmail, maskPhone } from '../notify/sender';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import { STAFF_CREATE_ROLES } from './drawer.dto';
import type {
  ChreqReviewDto, DrawerDto, MemberDto, ReqReviewDto, StaffCreateDto, StaffCreatedDto, StaffHandoverDto, StaffPatchDto,
  TodoCreateDto, TodoPatchDto,
} from './drawer.dto';
import bcrypt from 'bcryptjs';

type R = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const staffNotFound = () => new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 구성원을 찾을 수 없습니다' });
const staffEmailTaken = () =>
  new ConflictException({ code: 'STAFF_EMAIL_TAKEN', message: '그 이메일로 이미 구성원이 있습니다 — 로그인 아이디는 하나여야 합니다' });

/** 휴대폰 칸 — 비우면 null, 적었으면 숫자만(한국 휴대폰만). 모양이 아니면 400 — 번호 원문은 오류에 싣지 않는다 */
function staffPhoneOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const phone = normalizeMobile(raw);
  if (!phone) throw new BadRequestException({ code: 'STAFF_PHONE_INVALID', message: '휴대폰 번호 모양이 아닙니다 — 010으로 시작하는 번호를 적어 주세요' });
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

@Injectable()
export class DrawerService {
  constructor(
    @InjectRepository(Lead) private readonly anyRepo: Repository<Lead>,
    /** 변경 요청 반영은 **기존 일정 쓰기를 그대로 탄다** — 규칙을 두 벌 만들지 않는다 (C42) */
    private readonly schedWrite?: ScheduleWriteService,
    /** 줌 갈래도 같은 이유로 **줌 배정 경로를 그대로 탄다** (C48) */
    private readonly zoom?: ZoomService,
  ) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** §14 리포트·건의·빠진 것과 §75 결재 갈래를 읽어 공통 ApRow 한 모양으로 만든다. */
  private async approvalRows(): Promise<ApRow[]> {
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
         LEFT JOIN staff t ON t.id = o.teacher_id
        WHERE NOT o.canceled AND s.mode = 'online' AND o.zacc_id IS NULL
          AND lower(o.span) >= now() AND lower(o.span) < now() + interval '30 days'`,
    )) {
      rows.push({
        kind: 'missing', id: Number(r.id),
        title: `줌 계정 미배정 · ${str(r.title) ?? String(r.kind_key)}`,
        sub: [str(r.teacher_name), str(r.on_date)].filter(Boolean).join(' · '),
        byId: num(r.teacher_id), byName: str(r.teacher_name), at: String(r.at),
        state: 'waiting', why: null, go: `/schedule?d=${String(r.on_date)}`, applicable: false,
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
              p.owner_id, s.name AS owner_name, rejected.reason AS reject_reason
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id
         LEFT JOIN LATERAL (
           SELECT NULLIF(l.after->>'reason', '') AS reason
             FROM log l
            WHERE lower(l.entity) = 'plan' AND l.entity_id = p.id
              AND lower(l.action) IN ('rework', 'reject')
            ORDER BY l.at DESC, l.id DESC LIMIT 1
         ) rejected ON true`,
    )) {
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
        title: `${labelOf(REQ_TYPE_LABEL, reqType)} 요청`,
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
  ): Promise<DrawerDto> {
    const approvalRows = await this.approvalRows();
    const approvals = apFlow(approvalRows, viewerId, canApprove, canWage);
    const approvalFlow = approvalFlowProjection(approvalRows, viewerId, flowScope);

    // 할 일 — 강사는 자기 것만 (주고받은 것). 화면이 안 걸러도 서버가 거른다 (D-R39)
    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on,
              t.from_id, t.to_id, f.name AS from_name, s.name AS to_name,
              t.mt_id, t.cpl_id, t.cons_id, t.plan_id
         FROM todo t
         LEFT JOIN staff f ON f.id = t.from_id
         LEFT JOIN staff s ON s.id = t.to_id
        WHERE $2::boolean OR t.to_id = $1 OR t.from_id = $1
        ORDER BY t.done, t.due_on NULLS LAST, t.id`,
      [viewerId, canSeeAll],
    )).map((r) => ({
      id: Number(r.id), title: String(r.title),
      fromId: num(r.from_id), toId: num(r.to_id),
      fromName: str(r.from_name), toName: str(r.to_name),
      dueOn: str(r.due_on), done: r.done === true, src: String(r.src), srcLabel: todoSourceLabel(String(r.src)),
      overdueDays: r.done === true ? 0 : overdueDays(str(r.due_on)),
      // 출처가 있으면 원본으로 돌아갈 수 있다 (§15 규칙)
      go: r.mt_id || r.cpl_id ? '/ops' : r.cons_id ? '/consulting' : r.plan_id ? '/ops' : null,
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
    // 이메일은 로그인 아이디다. 강사 화면은 서랍을 그리지 않지만 경로는 열려 있으므로 SELECT 단계에서 뺀다 (보안 검수 0925 · D-R39)
    // 휴대폰도 연락처라 전체를 다루는 사람(canCrudAll)에게만 싣는다 — 아니면 SELECT 단계에서 뺀다 (W8)
    const members = (await this.q(
      `SELECT s.id, s.name, s.email, s.role::text AS role, s.title, s.tz, s.active,
              CASE WHEN $3::boolean THEN s.phone END AS phone, s.must_change_credentials,
              to_char(s.hired_on,'YYYY-MM-DD') AS hired_on,
              (s.role::text = ANY($5::text[])) AS manageable,
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
      id: Number(r.id), name: String(r.name), email: String(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: canWage && r.wage_rate != null ? Number(r.wage_rate) : null,
      wageFrom: canWage ? str(r.wage_from) : null,
      // 시급 줄을 둘 수 있는 줄은 표가 가른다(활성 강사) — 화면이 role 을 보지 않게 (D-R39)
      wageable: canWage && r.wageable === true,
      mustChangeCredentials: r.must_change_credentials === true,
      phone: str(r.phone),
      hiredOn: str(r.hired_on),
      // 「수정」·「비밀번호 초기화」·「사용 중지」·「삭제」가 서는 줄도 표가 가른다(강사·매니저 · 자기 줄 제외) — W8
      ...staffRowFlags(canManageStaff, r.manageable === true, Number(r.id) === viewerId),
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
      canWage,
    };
  }

  /* ══ 쓰기 — §14~§16의 입력은 모두 여기서 DB 권한을 다시 검사한다 ═══════ */

  /**
   * §17 「+ 구성원」 (C97 · 테스트 시나리오 D-41 「신규 강사 등록」).
   * 역할은 강사·매니저뿐(DTO enum · 대표·관리자 계정은 이 길로 만들지 않는다 — 권한 상승 경로를 두지 않는다).
   * 이메일은 유일(표 UNIQUE 가 마지막에 막는다 · 먼저 읽어 409 문장을 준다) · 시간대는 `tzg` 에 있는 값만(C41 과 같은 낱말 `TZ_UNKNOWN`).
   * 비밀번호는 bcryptjs 해시로만 저장하고 어느 응답에도 싣지 않는다. 시급을 적었으면 **같은 트랜잭션**에 `insertWage`(입사일 또는 오늘부터 · 소급 없음).
   *
   * **시급을 적으려면 `canWage` 여야 한다**(S4). `insertWage` 를 타는 다른 두 경로 — `POST /accounting/wages`
   * (`@Perm('canAdminPage','canWage')`)와 §14 시급 요청 승인(`reviewRequest` 의 `WAGE_REVIEW_FORBIDDEN`) — 는 둘 다
   * 요구하는데 이 자리만 안 물었다. `can_wage=false` 예외가 걸린 매니저가 「+ 구성원」으로 시급을 세우면
   * **그 예외가 존재하는 이유 자체를 우회한다.** 구성원을 만드는 것과 시급을 정하는 것은 다른 권한이므로
   * 만들기 자체는 막지 않고 **시급 칸만** 막는다 — 시급을 비우면 그대로 만들어진다.
   */
  async createStaff(viewerId: number, canWage: boolean, dto: StaffCreateDto): Promise<StaffCreatedDto> {
    const today = todayKst();
    if (dto.wageRate != null && !canWage) {
      throw new ForbiddenException({
        code: 'WAGE_SET_FORBIDDEN',
        message: '시급을 다룰 권한이 필요합니다 — 시급을 비우고 만든 뒤 시급 담당자가 「시급 수정」으로 세울 수 있습니다',
      });
    }
    // 휴대폰은 숫자만 저장한다 — 첫 설정의 문자 확인(SENS)이 같은 모양을 본다 (lib/account-policy)
    const phone = staffPhoneOf(dto.phone);
    const tz = dto.tz?.trim() || KST;
    const [known] = (await this.q(`SELECT tz FROM tzg WHERE tz = $1`, [tz])) as Array<{ tz: string }>;
    if (!known) {
      throw new ConflictException({ code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요' });
    }
    const email = normalizeLoginEmail(dto.email);
    const [taken] = (await this.q(`SELECT id FROM staff WHERE lower(email) = $1`, [email])) as Array<{ id: string }>;
    if (taken) throw staffEmailTaken();
    const hiredOn = dto.hiredOn ?? today;
    /*
     * 비밀번호는 **서버가** 정한다 (W8 · 대표 지시 2026-09-26) — 만드는 사람이 고른 비밀번호는 만든 사람도 안다.
     * 초기 비밀번호로 만들고 첫 설정(아이디·비밀번호 변경 · 휴대폰·이메일 확인)을 걸어 둔다. 첫 로그인 때 본인이 바꾼다.
     */
    const hash = await bcrypt.hash(INITIAL_PASSWORD, 10);
    const id = await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      let made: { id: string };
      try {
        [made] = (await m.query(
          `INSERT INTO staff (name, email, phone, role, title, tz, password_hash, hired_on, active, must_change_credentials)
           VALUES ($1, $2, $3, $4::role_t, $5, $6, $7, $8::date, true, true) RETURNING id`,
          [dto.name, email, phone, dto.role, dto.title?.trim() || null, tz, hash, hiredOn],
        )) as Array<{ id: string }>;
      } catch (e) {
        // 동시에 같은 이메일로 만든 사람이 있으면 표의 유일 제약이 마지막에 막는다 — 오류 원문(값이 든다) 대신 같은 409 문장
        if ((e as { code?: string }).code === '23505') throw staffEmailTaken();
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
    const member = await this.memberOne(id, canWage, viewerId, true);
    // 넘겨줄 정보는 **이 응답에만** 싣는다 — 목록·기록(log)에는 없다
    return { ...member, loginId: member.email, initialPassword: INITIAL_PASSWORD };
  }

  /**
   * 구성원 한 줄 — `all()` 의 members 와 같은 모양(시급은 canWage 일 때만 · 휴대폰과 줄 플래그는 canManage 일 때만).
   * 부르는 곳은 전부 매니저 이상 경로(`@Perm('canAdminPage','canCrudAll')`)다.
   */
  private async memberOne(id: number, canWage: boolean, viewerId: number, canManage: boolean): Promise<MemberDto> {
    const [r] = await this.q(
      `SELECT id, name, email, phone, role::text AS role, title, tz, active, must_change_credentials,
              to_char(hired_on,'YYYY-MM-DD') AS hired_on,
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
      id: Number(r.id), name: String(r.name), email: String(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: wage[0] ? Number(wage[0].rate) : null, wageFrom: wage[0] ? String(wage[0].from_date) : null,
      wageable: canWage && r.wageable === true,
      mustChangeCredentials: r.must_change_credentials === true,
      phone: canManage ? str(r.phone) : null,
      hiredOn: str(r.hired_on),
      ...staffRowFlags(canManage, r.manageable === true, Number(r.id) === viewerId),
    };
  }

  /* ══ §17 사용자 표 CRUD (W8 · 대표 지시 2026-09-26 「매니저 이상급부터 user table CRUD 가능하게」) ══════
     경로 가드는 컨트롤러의 `@Perm('canAdminPage','canCrudAll')` 이고, 여기서는 **대상 줄**을 다시 본다 —
     대표·관리자 줄은 이 길로 못 건드린다(STAFF_PROTECTED · 매니저가 대표 계정을 고치거나 가져가지 못하게).
     자기 줄은 역할 · 초기화 · 사용 중지 · 삭제가 막힌다 — 자기 계정을 스스로 잠그거나 올리는 길을 두지 않는다. */

  /** 대상 줄을 잠그고 읽는다 — 없으면 404, 강사·매니저가 아니면 403 */
  private async lockManageable(m: EntityManager, id: number): Promise<Record<string, unknown>> {
    const [row] = (await m.query(
      `SELECT id, name, email, phone, role::text AS role, title, tz, active, must_change_credentials,
              to_char(hired_on,'YYYY-MM-DD') AS hired_on, (role::text = ANY($2::text[])) AS manageable
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
   * 「수정」 — 보낸 칸만 바꾼다. 이메일(=아이디)을 바꾸면 이메일 확인이, 휴대폰을 바꾸면 휴대폰 확인이 풀린다
   * (확인한 것은 **옛 값**이다). 기록(log)에는 바뀐 칸만 남기고 연락처는 가린 모양으로만 적는다.
   */
  async updateStaff(viewerId: number, canWage: boolean, id: number, dto: StaffPatchDto): Promise<MemberDto> {
    const phone = dto.phone === undefined ? undefined : staffPhoneOf(dto.phone);
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const row = await this.lockManageable(m, id);
      const cur: Record<string, string | null> = {
        name: str(row.name), email: str(row.email), phone: str(row.phone), title: str(row.title),
        tz: str(row.tz), role: str(row.role), hiredOn: str(row.hired_on),
      };
      const next: Record<string, string | null | undefined> = {
        name: dto.name, email: dto.email === undefined ? undefined : normalizeLoginEmail(dto.email), phone,
        title: dto.title === undefined ? undefined : (dto.title?.trim() || null),
        tz: dto.tz?.trim(), role: dto.role, hiredOn: dto.hiredOn,
      };
      // 보낸 값 중 **지금과 다른 것만** 바꾼다 — 같은 값을 다시 보낸 칸은 바뀐 것이 아니다
      const changed: Record<string, string | null> = {};
      for (const key of Object.keys(next)) {
        const value = next[key];
        if (value !== undefined && value !== cur[key]) changed[key] = value;
      }
      if (Object.keys(changed).length === 0) {
        throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 항목이 없습니다' });
      }
      if ('role' in changed && id === viewerId) {
        throw new ForbiddenException({ code: 'SELF_ROLE', message: '자기 역할은 바꿀 수 없습니다 — 다른 매니저 이상에게 부탁하세요' });
      }
      if ('tz' in changed) {
        const [known] = (await m.query(`SELECT tz FROM tzg WHERE tz = $1`, [changed.tz])) as Array<{ tz: string }>;
        if (!known) {
          throw new ConflictException({ code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요' });
        }
      }
      if ('email' in changed) {
        const [taken] = (await m.query(`SELECT id FROM staff WHERE lower(email) = $1 AND id <> $2`, [changed.email, id])) as Array<{ id: string }>;
        if (taken) throw staffEmailTaken();
      }
      // 칸 이름은 이 표에서만 온다 — 보낸 글이 SQL 이 되지 않는다(값은 전부 $n)
      const COLUMN: Record<string, string> = {
        name: 'name', email: 'email', phone: 'phone', title: 'title', tz: 'tz', role: 'role', hiredOn: 'hired_on',
      };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, value] of Object.entries(changed)) {
        params.push(value);
        const cast = key === 'role' ? '::role_t' : key === 'hiredOn' ? '::date' : '';
        sets.push(`${COLUMN[key]} = $${params.length}${cast}`);
      }
      if ('email' in changed) sets.push('email_verified = false');
      if ('phone' in changed) sets.push('phone_verified = false');
      try {
        await m.query(`UPDATE staff SET ${sets.join(', ')} WHERE id = $1`, params);
      } catch (e) {
        // 동시에 같은 이메일로 바꾼 사람이 있으면 표의 UNIQUE 가 마지막에 막는다
        if ((e as { code?: string }).code === '23505') throw staffEmailTaken();
        throw e;
      }
      const shown = (key: string, value: string | null) =>
        value === null ? null : key === 'email' ? maskEmail(value) : key === 'phone' ? maskPhone(value) : value;
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(changed)) {
        before[key] = shown(key, cur[key] ?? null);
        after[key] = shown(key, value);
      }
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STAFF',$2,'update',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify(before), JSON.stringify(after)],
      );
    });
    return this.memberOne(id, canWage, viewerId, true);
  }

  /**
   * 「비밀번호 초기화」 — 초기 비밀번호로 되돌리고 첫 설정을 다시 건다. 세션을 끊는 시각(credentials_changed_at)도
   * 적는다 — 그 전에 받은 토큰은 인증에서 막힌다(W8-A). 자기 것은 첫 설정 흐름으로 바꾼다(SELF_RESET).
   */
  async resetStaffPassword(viewerId: number, id: number): Promise<StaffHandoverDto> {
    if (id === viewerId) {
      throw new ForbiddenException({ code: 'SELF_RESET', message: '자기 비밀번호는 여기서 초기화하지 않습니다 — 로그인한 뒤 첫 설정 화면에서 바꾸세요' });
    }
    const hash = await bcrypt.hash(INITIAL_PASSWORD, 10);
    const email = await this.anyRepo.manager.transaction(async (m: EntityManager) => {
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
      return String(row.email);
    });
    return { loginId: email, initialPassword: INITIAL_PASSWORD };
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

  /** §15 수동 할 일 만들기. 다른 사람에게 배정하려면 canCrudAll 이어야 한다. */
  async createTodo(viewerId: number, canSeeAll: boolean, dto: TodoCreateDto): Promise<{ id: number }> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException({ code: 'TODO_TITLE_REQUIRED', message: '할 일을 적어 주세요' });
    const toId = dto.toId ?? viewerId;
    if (toId !== viewerId && !canSeeAll) {
      throw new ForbiddenException({ code: 'TODO_ASSIGN_FORBIDDEN', message: '다른 사람에게 할 일을 배정할 권한이 없습니다' });
    }
    const [staff] = await this.q(`SELECT id, name FROM staff WHERE id = $1 AND active`, [toId]);
    if (!staff) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '활성 구성원을 찾을 수 없습니다' });
    const [row] = await this.q(
      `INSERT INTO todo (title, from_id, to_id, due_on, src)
       VALUES ($1, $2, $3, $4::date, 'manual') RETURNING id`,
      [title, viewerId, toId, dto.dueOn ?? null],
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
   */
  async clearDoneTodos(viewerId: number, canSeeAll: boolean, ids: readonly number[]): Promise<number> {
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const gone = (await m.query(
        `DELETE FROM todo
          WHERE id = ANY($3::bigint[]) AND done AND ($2::boolean OR to_id = $1 OR from_id = $1)
          RETURNING id, title, src, to_id, from_id, to_char(due_on,'YYYY-MM-DD') AS due_on`,
        [viewerId, canSeeAll, [...ids]],
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
      return true;
    });
  }

  /** §15 할 일 체크. 강사는 **자기가 주고받은 것만** 건드린다 (D-R39) */
  async setTodoDone(id: number, done: boolean, viewerId: number, canSeeAll: boolean): Promise<boolean> {
    const rows = await this.q(
      `UPDATE todo SET done = $2
        WHERE id = $1 AND ($4::boolean OR to_id = $3 OR from_id = $3)
        RETURNING id`,
      [id, done, viewerId, canSeeAll],
    );
    return writtenRows(rows).length > 0;
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
   *   그 밖        → **적용 대상이 없다.** 상태만 닫는다 — 없는 적용을 지어내지 않는다
   *
   * 잠금·적용·기록이 **한 트랜잭션**이다 (D-R43 · 원칙 26). 두 사람이 같은 줄을 동시에
   * 승인하면 뒤엣사람은 REQ_NOT_PENDING 으로 막히고 시급 줄이 두 개 생기지 않는다.
   */
  async reviewRequest(
    reqId: number, viewerId: number, dto: ReqReviewDto, canWage: boolean,
  ): Promise<{ id: number; state: string; applied: string | null }> {
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
        `SELECT id, staff_id, req_type, payload, state FROM req WHERE id = $1 FOR UPDATE`, [reqId],
      )) as Array<{ id: string; staff_id: string; req_type: string; payload: Record<string, unknown> | null; state: string }>;
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
        await insertWage(m, { staffId: byId, rate, fromDate: today, reason, approvedBy: viewerId }, today);
        applied = `${reqAsked(req.req_type, payload).to} · ${today}부터`;
      }

      if (approving && req.req_type === 'tz_change') {
        const tz = String(payload.tz ?? '');
        const [known] = (await m.query(`SELECT tz FROM tzg WHERE tz = $1`, [tz])) as Array<{ tz: string }>;
        if (!known) {
          throw new ConflictException({
            code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요',
          });
        }
        await m.query(`UPDATE staff SET tz = $2 WHERE id = $1`, [byId, tz]);
        applied = tz;
      }

      await m.query(
        `UPDATE req SET state = $2, resolved_by = $3, reject_reason = $4 WHERE id = $1`,
        [reqId, approving ? 'approved' : 'rejected', viewerId, approving ? null : reason],
      );

      const label = labelOf(REQ_TYPE_LABEL, req.req_type);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'req', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, reqId, approving ? 'approve' : 'reject',
          JSON.stringify({ state: 'pending' }),
          JSON.stringify({ state: approving ? 'approved' : 'rejected', applied, reason })],
      );
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

      return { id: reqId, state: approving ? 'approved' : 'rejected', applied };
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
  ): Promise<{ id: number; state: string; applied: string | null }> {
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

    /** 요청을 닫고 이력을 남긴다 — 반영이면 **일정 쓰기와 같은 트랜잭션 안**에서 돈다 */
    const close = async (run: (sql: string, p: unknown[]) => Promise<unknown>) => {
      const done = await run(
        `UPDATE chreq SET state = $2, resolved_by = $3, resolved_at = now(), reject_reason = $4
          WHERE id = $1 AND state = 'pending' RETURNING id`,
        [chreqId, approving ? 'approved' : 'rejected', viewerId, approving ? null : reason],
      );
      // 잠깐 사이에 남이 처리했다면 **여기서 멈춘다** — 반영 중이면 트랜잭션째 되돌아간다
      if (writtenRows(done).length === 0) {
        throw new ConflictException({ code: 'CHREQ_NOT_PENDING', message: '이미 처리된 요청입니다' });
      }
      await run(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'chreq', $2, $3, $4::jsonb, $5::jsonb)`,
        [viewerId, chreqId, approving ? 'apply' : 'reject',
          JSON.stringify({ state: 'pending' }),
          JSON.stringify({ state: approving ? 'approved' : 'rejected', asked, reason })],
      );
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
      return { id: chreqId, state: 'rejected', applied: null };
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
       요청도 pending 으로 되돌아간다. 전에는 경로가 없어 이 갈래만 막혀 있었다 (C48 이 열었다). */
    const p0 = (req.payload ?? {}) as Record<string, unknown>;
    if (req.req_type === 'room' && p0.zaccId !== undefined) {
      if (!this.zoom) throw new Error('ZoomService 가 주입되지 않았습니다');
      await this.anyRepo.manager.transaction(async (m: EntityManager) => {
        await this.zoom!.assignIn(m, viewerId, {
          serId,
          // apply_all 이면 규칙 전체, 아니면 그 회차만 (D-R16 과 같은 뜻)
          onDate: req.apply_all ? undefined : req.on_date,
          zaccId: Number(p0.zaccId),
        });
        // 일반 일정 승인처럼 SER→CHREQ 순서다. 먼저 처리됐으면 close의 pending CAS가 전부 되돌린다.
        await m.query(`SELECT id FROM chreq WHERE id = $1 FOR UPDATE`, [chreqId]);
        await close((sql, p) => m.query(sql, p));
      });
      return { id: chreqId, state: 'approved', applied: asked };
    }

    if (req.req_type === 'cancel') {
      await this.schedWrite.remove(serId, { scope, onDate: req.on_date }, inside);
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
      await this.schedWrite.patch(serId, patch as never, inside);
    }
    return { id: chreqId, state: 'approved', applied: asked };
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
