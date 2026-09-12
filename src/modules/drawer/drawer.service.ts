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
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import {
  apFlow, labelOf, reqAsked, reqAskedLine, toApState,
  GPAPACK_TYPE_LABEL, REQ_TYPE_LABEL, RPT_TYPE_LABEL, type ApRow,
} from '../../lib/approval';
import { isChreqType, type NormalizedChangeRequest } from '../../lib/change-request';
import { NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory, notiTone } from '../../lib/noti';
import { START_MIN, END_MIN, kstAt, writtenRows } from '../../lib/sql';
import { KST, overdueDays, todayKst } from '../../lib/kst';
import type { DrawerDto, ReqReviewDto } from './drawer.dto';

type R = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class DrawerService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** §75 공통 다섯 갈래와 §14 강사 리포트를 읽어 한 모양으로 만든다. */
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
        state: toApState(str(r.state)), why: str(r.reject_reason), go: '/reports',
      });
    }

    for (const r of await this.q(
      `SELECT r.id, r.rpt_type, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state, r.reject_reason,
              ${kstAt(`COALESCE(r.sent_at, r.on_date::timestamptz)`)} AS at
         FROM rpt r
        -- 아직 안 낸 초안은 아무도 기다리지 않는다.
        -- 한동안 <> 'na' 였는데 rpt 에 'na' 라는 낱말이 없어서 이 줄이 **아무 일도 안 했다** —
        -- 초안이 승인 대기함에 떠서 배지 숫자를 올리고 있었다.
        WHERE r.state <> 'draft'`,
    )) {
      rows.push({
        kind: 'rpt', id: Number(r.id),
        title: `${labelOf(RPT_TYPE_LABEL, String(r.rpt_type))} 보고`,
        sub: String(r.on_date), byId: null, byName: null, at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason), go: '/exec',
      });
    }

    for (const r of await this.q(
      `SELECT p.id, p.title, p.stage, ${kstAt(`p.created_at`)} AS at,
              p.owner_id, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id`,
    )) {
      rows.push({
        kind: 'plan', id: Number(r.id), title: String(r.title), sub: '기획',
        byId: num(r.owner_id), byName: str(r.owner_name), at: String(r.at),
        state: toApState(str(r.stage)), why: null, go: '/ops',
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
        state: toApState(str(r.state)), why: str(r.reject_reason), go: '/ops',
        reqType, asked: reqAskedLine(reqType, r.payload),
      });
    }

    for (const r of await this.q(
      `SELECT c.id, c.req_type, c.state, c.reason, c.by_id, s.name AS by_name,
              to_char(c.on_date,'YYYY-MM-DD') AS on_date,
              ${kstAt(`c.created_at`)} AS at
         FROM chreq c LEFT JOIN staff s ON s.id = c.by_id`,
    )) {
      rows.push({
        kind: 'chreq', id: Number(r.id),
        title: `${labelOf(REQ_TYPE_LABEL, String(r.req_type))} 요청`,
        sub: str(r.on_date), byId: num(r.by_id), byName: str(r.by_name), at: String(r.at),
        // 변경 요청은 반려 사유와 신청 사유가 같은 컬럼이라, 되돌아온 것일 때만 사유로 읽는다
        state: toApState(str(r.state)),
        why: toApState(str(r.state)) === 'back' ? str(r.reason) : null,
        go: '/schedule',
      });
    }

    // 다섯 번째 — 자료 요청 (§82). 올린 사람 컬럼이 없어 byId 는 없다.
    for (const r of await this.q(
      `SELECT g.id, g.pack_type, g.state, g.detail, s.name AS stu_name,
              ${kstAt(`g.created_at`)} AS at
         FROM gpapack g LEFT JOIN stu s ON s.id = g.student_id`,
    )) {
      rows.push({
        kind: 'gpapack', id: Number(r.id),
        title: str(r.stu_name) ?? '학생',
        sub: [labelOf(GPAPACK_TYPE_LABEL, String(r.pack_type)), str(r.detail)]
          .filter(Boolean).join(' · '),
        byId: null, byName: null, at: String(r.at),
        state: toApState(str(r.state)), why: null, go: '/consulting',
      });
    }

    return rows;
  }

  async all(viewerId: number, canApprove: boolean, canSeeAll: boolean, notiAll = false): Promise<DrawerDto> {
    const approvals = apFlow(await this.approvalRows(), viewerId, canApprove);

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
      dueOn: str(r.due_on), done: r.done === true, src: String(r.src),
      overdueDays: r.done === true ? 0 : overdueDays(str(r.due_on)),
      // 출처가 있으면 원본으로 돌아갈 수 있다 (§15 규칙)
      go: r.mt_id || r.cpl_id ? '/ops' : r.cons_id ? '/consulting' : r.plan_id ? '/ops' : null,
    }));

    /* §16 — 기본은 최근 30일만 **보여 준다.** 지우는 것이 아니다 (N-7 · D-16).
       창 밖에 몇 건이 남아 있는지 함께 세어, 화면이 「없어진 것이 아니라 안 보이는 것」이라고 말할 수 있게 한다. */
    const windowDays = notiAll ? 0 : NOTI_WINDOW_DAYS;
    const notis = (await this.q(
      `SELECT n.id, n.body, n.link, n.to_id, n.read_at, f.name AS from_name,
              ${kstAt(`n.created_at`)} AS at
         FROM noti n LEFT JOIN staff f ON f.id = n.from_id
        WHERE ($2::boolean OR n.to_id = $1)
          AND ($3::int = 0 OR n.created_at >= now() - make_interval(days => $3::int))
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC`,
      [viewerId, canSeeAll, windowDays],
    )).map((r) => {
      const link = str(r.link);
      const category = notiCategory(link);
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

    const members = (await this.q(
      `SELECT id, name, email, role::text AS role, title, tz, active FROM staff ORDER BY active DESC, id`,
    )).map((r) => ({
      id: Number(r.id), name: String(r.name), email: String(r.email),
      role: String(r.role), title: str(r.title), tz: str(r.tz), active: r.active === true,
    }));

    const tzGroups = (await this.q(`SELECT id, name, tz FROM tzg ORDER BY id`))
      .map((r) => ({ id: Number(r.id), name: String(r.name), tz: String(r.tz) }));

    const kinds = (await this.q(
      `SELECT key, name, color, cap, grp::text AS grp, rep FROM kind ORDER BY sort`,
    )).map((r) => ({
      key: String(r.key), name: String(r.name), color: String(r.color),
      cap: Number(r.cap), grp: String(r.grp), rep: r.rep === true,
    }));

    const changeReqs = (await this.q(
      `SELECT c.id, c.req_type, c.ser_id, to_char(c.on_date,'YYYY-MM-DD') AS on_date,
              c.reason, c.state, c.apply_all, s.name AS by_name,
              ${kstAt(`c.created_at`)} AS at
         FROM chreq c LEFT JOIN staff s ON s.id = c.by_id
        WHERE $2::boolean OR c.by_id = $1
        ORDER BY c.created_at DESC`,
      [viewerId, canSeeAll],
    )).map((r) => {
      const reqType = String(r.req_type);
      if (!isChreqType(reqType)) throw new Error(`CHREQ.req_type 계약 밖의 값입니다: ${reqType}`);
      return {
        id: Number(r.id), reqType, serId: Number(r.ser_id),
        onDate: String(r.on_date), reason: String(r.reason), state: String(r.state),
        byName: str(r.by_name), applyAll: r.apply_all === true, at: String(r.at),
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

    return {
      approvals, todos, notis,
      notiWindowDays: windowDays,
      notiOlderCount: Number(older?.n ?? 0),
      members, tzGroups, kinds, changeReqs, zoomAccounts,
      tz: KST,
    };
  }

  /* ══ 쓰기 — 서랍이 하는 일은 세 가지뿐 ═══════════════════════════════════
     승인·반려는 없다. 줄을 누르면 그 화면으로 간다 (D-R27).                 */

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
        const [dup] = (await m.query(
          `SELECT id FROM wage WHERE staff_id = $1 AND from_date = $2::date`, [byId, today],
        )) as Array<{ id: string }>;
        if (dup) {
          throw new ConflictException({
            code: 'WAGE_SAME_DAY',
            message: '오늘 날짜로 적용된 시급이 이미 있습니다 — 지난 수업은 그때 시급 그대로여야 해서 같은 날 두 번 바꾸지 않습니다',
          });
        }
        // **소급 없음** — 오늘부터의 수업에만 붙는다 (D8). 지난 정산은 흔들리지 않는다.
        await m.query(
          `INSERT INTO wage (staff_id, rate, from_date, reason, approved_by)
           VALUES ($1, $2, $3::date, $4, $5)`,
          [byId, rate, today, reason, viewerId],
        );
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
      // 올린 사람은 결과를 알아야 한다 — 링크에서 「요청 처리」 분류가 파생된다 (§16)
      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link) VALUES ($1, $2, $3, $4)`,
        [byId, viewerId,
          approving
            ? `${label} 요청이 승인됐습니다${applied ? ` — ${applied}` : ''}`
            : `${label} 요청이 반려됐습니다 — ${reason}`,
          '/teacher?req'],
      );

      return { id: reqId, state: approving ? 'approved' : 'rejected', applied };
    });
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
