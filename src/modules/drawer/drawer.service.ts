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
  apFlow, approvalFlowProjection, labelOf, reqAsked, reqAskedLine, toApState,
  GPAPACK_TYPE_LABEL, REQ_TYPE_LABEL, RPT_TYPE_LABEL, type ApRow,
} from '../../lib/approval';
import { kindGroupLabel } from '../../lib/catalog-words';
import { chreqApplicable, chreqAsked, isChreqType, type NormalizedChangeRequest } from '../../lib/change-request';
import { ZoomService } from '../zoom/zoom.service';
import { NOTI_CATEGORIES, NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory, notiTone } from '../../lib/noti';
import { groupByRole } from '../../lib/role-words';
import { START_MIN, END_MIN, kstAt, writtenRows } from '../../lib/sql';
import { todoSourceLabel } from '../../lib/todo';
import { KST, overdueDays, todayKst } from '../../lib/kst';
import { insertWage } from '../../lib/wage';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import type { ChreqReviewDto, DrawerDto, MemberDto, ReqReviewDto, StaffCreateDto, TodoCreateDto } from './drawer.dto';
import bcrypt from 'bcryptjs';

type R = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

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
      rows.push({
        kind: 'req', id: Number(r.id),
        title: `${labelOf(REQ_TYPE_LABEL, reqType)} 요청`,
        // 「무엇을 바라는가」를 줄에 적는다 — 근거를 안 보고 누르는 승인이 되지 않도록 (§14)
        sub: reqAskedLine(reqType, r.payload),
        byId: num(r.staff_id), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason),
        go: `/ops?tab=todo&request=${Number(r.id)}`,
        reqType, asked: reqAskedLine(reqType, r.payload),
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
      rows.push({
        kind: 'chreq', id: Number(r.id),
        title: `${labelOf(REQ_TYPE_LABEL, reqType)} 요청`,
        // 원문 §20 이력 줄의 모양 — 「MAP Reading 8/28 강사 → KJ (이 주만)」
        sub: [str(r.ser_title), str(r.on_date), asked, r.apply_all === true ? '(이후 전체)' : '(이 회차만)']
          .filter(Boolean).join(' · '),
        byId: num(r.by_id), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)),
        // 반려 사유는 이제 제 칸이 있다 (v4.18) — 옛 행은 신청 사유 칸에만 있어 그것으로 갈음한다
        why: toApState(str(r.state)) === 'back' ? (str(r.reject_reason) ?? str(r.reason)) : null,
        go: `/schedule?changeRequest=${Number(r.id)}`,
        reqType, asked, applicable: chreqApplicable(reqType, r.payload),
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
      const sub = [str(r.stu_names), r.effective_on ? `기한 ${String(r.effective_on)}` : null, str(r.memo)]
        .filter(Boolean).join(' · ');
      rows.push({
        kind: 'gpapack', id: Number(r.id),
        title: [`${labelOf(GPAPACK_TYPE_LABEL, String(r.pack_type))} 자료 요청`, str(r.title)]
          .filter(Boolean).join(' · '),
        sub: sub || null,
        byId: num(r.created_by), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: null,
        go: `/books?tab=requests&pack=${Number(r.id)}`,
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
  ): Promise<DrawerDto> {
    const approvalRows = await this.approvalRows();
    const approvals = apFlow(approvalRows, viewerId, canApprove);
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
      `SELECT n.id, n.body, n.link, n.category, n.to_id, n.read_at, f.name AS from_name,
              ${kstAt(`n.created_at`)} AS at
         FROM noti n LEFT JOIN staff f ON f.id = n.from_id
        WHERE ($2::boolean OR n.to_id = $1)
          AND ($3::int = 0 OR n.created_at >= now() - make_interval(days => $3::int))
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC`,
      [viewerId, canSeeAll, windowDays],
    )).map((r) => {
      const link = str(r.link);
      const category = notiCategory(str(r.category), link);
      return {
        id: Number(r.id), body: String(r.body), fromName: str(r.from_name),
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
    const members = (await this.q(
      `SELECT s.id, s.name, s.email, s.role::text AS role, s.title, s.tz, s.active,
              w.rate AS wage_rate, to_char(w.from_date,'YYYY-MM-DD') AS wage_from,
              (s.role = 'teacher' AND s.active) AS wageable
         FROM staff s
         LEFT JOIN LATERAL (
           SELECT rate, from_date FROM wage
            WHERE $2::boolean AND staff_id = s.id AND from_date <= $1::date
            ORDER BY from_date DESC LIMIT 1
         ) w ON true
        ORDER BY s.active DESC, s.id`,
      [todayKst(), canWage],
    )).map((r) => ({
      id: Number(r.id), name: String(r.name), email: String(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: canWage && r.wage_rate != null ? Number(r.wage_rate) : null,
      wageFrom: canWage ? str(r.wage_from) : null,
      // 시급 줄을 둘 수 있는 줄은 표가 가른다(활성 강사) — 화면이 role 을 보지 않게 (D-R39)
      wageable: canWage && r.wageable === true,
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
    const zoomAccounts = (await this.q(
      `SELECT z.id, z.label, z.join_url, z.active,
              (SELECT count(*) FROM ser_occ o WHERE o.zacc_id = z.id AND NOT o.canceled)::int AS assigned,
              (SELECT count(*) FROM ser_occ a JOIN ser_occ b
                      ON a.zacc_id = b.zacc_id AND a.id < b.id AND a.span && b.span
                WHERE a.zacc_id = z.id AND NOT a.canceled AND NOT b.canceled)::int AS overlaps
         FROM zacc z ORDER BY z.active DESC, z.id`,
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
  async createStaff(viewerId: number, canWage: boolean, dto: StaffCreateDto): Promise<MemberDto> {
    const today = todayKst();
    if (dto.wageRate != null && !canWage) {
      throw new ForbiddenException({
        code: 'WAGE_SET_FORBIDDEN',
        message: '시급을 다룰 권한이 필요합니다 — 시급을 비우고 만든 뒤 시급 담당자가 「시급 수정」으로 세울 수 있습니다',
      });
    }
    const tz = dto.tz?.trim() || KST;
    const [known] = (await this.q(`SELECT tz FROM tzg WHERE tz = $1`, [tz])) as Array<{ tz: string }>;
    if (!known) {
      throw new ConflictException({ code: 'TZ_UNKNOWN', message: '시간대 목록에 없는 값입니다 — 구성원·시간대에서 먼저 추가하세요' });
    }
    const [taken] = (await this.q(`SELECT id FROM staff WHERE lower(email) = lower($1)`, [dto.email])) as Array<{ id: string }>;
    if (taken) {
      throw new ConflictException({ code: 'STAFF_EMAIL_TAKEN', message: '그 이메일로 이미 구성원이 있습니다 — 로그인 아이디는 하나여야 합니다' });
    }
    const hiredOn = dto.hiredOn ?? today;
    const hash = await bcrypt.hash(dto.password, 10);
    const id = await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [made] = (await m.query(
        `INSERT INTO staff (name, email, phone, role, title, tz, password_hash, hired_on, active)
         VALUES ($1, lower($2), $3, $4::role_t, $5, $6, $7, $8::date, true) RETURNING id`,
        [dto.name, dto.email, dto.phone?.trim() || null, dto.role, dto.title?.trim() || null, tz, hash, hiredOn],
      )) as Array<{ id: string }>;
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
    return this.memberOne(id, canWage);
  }

  /** 구성원 한 줄 — `all()` 의 members 와 같은 모양(시급은 canWage 일 때만) */
  private async memberOne(id: number, canWage: boolean): Promise<MemberDto> {
    const [r] = await this.q(
      `SELECT id, name, email, role::text AS role, title, tz, active, (role = 'teacher' AND active) AS wageable FROM staff WHERE id = $1`, [id],
    );
    if (!r) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 구성원을 찾을 수 없습니다' });
    const wage = canWage ? await this.q(
      `SELECT rate, to_char(from_date,'YYYY-MM-DD') AS from_date FROM wage WHERE staff_id = $1 AND from_date <= $2::date ORDER BY from_date DESC LIMIT 1`,
      [id, todayKst()],
    ) : [];
    return {
      id: Number(r.id), name: String(r.name), email: String(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
      wageRate: wage[0] ? Number(wage[0].rate) : null, wageFrom: wage[0] ? String(wage[0].from_date) : null,
      wageable: canWage && r.wageable === true,
    };
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
      // 올린 사람은 결과를 알아야 한다 — 분류는 NOTI.category에 명시한다 (§16)
      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, $4, 'request')`,
        [byId, viewerId,
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
        `INSERT INTO noti (to_id, from_id, body, link, category) VALUES ($1, $2, $3, $4, 'schedule')`,
        [Number(req.by_id), viewerId,
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
        await m.query(`SELECT id FROM chreq WHERE id = $1 FOR UPDATE`, [chreqId]);
        await this.zoom!.assignIn(m, viewerId, {
          serId,
          // apply_all 이면 규칙 전체, 아니면 그 회차만 (D-R16 과 같은 뜻)
          onDate: req.apply_all ? undefined : req.on_date,
          zaccId: Number(p0.zaccId),
        });
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

  /** 겹침을 볼 때 필요한 회차의 시각·자원 — 요청서에 안 적힌 것은 원본에서 가져온다 */
  async occOf(serId: number, onDate: string): Promise<{
    startMin: number; endMin: number; teacherId: number | null; roomId: number | null; zaccId: number | null;
  } | null> {
    const rows = await this.q(
      `SELECT ${START_MIN} AS start_min, ${END_MIN} AS end_min,
              o.teacher_id, o.room_id, o.zacc_id
         FROM ser_occ o WHERE o.ser_id = $1 AND o.on_date = $2 LIMIT 1`,
      [serId, onDate],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      startMin: Number(r.start_min), endMin: Number(r.end_min),
      teacherId: num(r.teacher_id), roomId: num(r.room_id), zaccId: num(r.zacc_id),
    };
  }
}
