/**
 * 우측 서랍 — §14~§21 여덟 칸.
 *
 * 서랍은 **전역**이다. 어느 탭에서 열든 같은 것이 보여야 하므로 한 번에 다 내려보낸다 —
 * 칸마다 엔드포인트를 두면 서랍을 열 때마다 왕복이 여덟 번이다.
 *
 * 결재 정규화는 `lib/approval.ts` 가 갖는다. 여기서는 행을 읽어 그 함수에 넘길 뿐이다 —
 * §14 승인 대기함과 §75 결재 흐름이 **같은 함수**를 보게 하는 것이 요점이다 (D-R26).
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import {
  apFlow, labelOf, toApState,
  GPAPACK_TYPE_LABEL, REQ_TYPE_LABEL, RPT_TYPE_LABEL, type ApRow,
} from '../../lib/approval';
import { notiTone } from '../../lib/noti';
import { START_MIN, END_MIN, kstAt } from '../../lib/sql';
import type { DrawerDto } from './drawer.dto';

type R = Record<string, unknown>;

const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const overdue = (due?: string | null) => {
  if (!due) return 0;
  const d = (new Date(`${todayKst()}T00:00:00Z`).getTime() - new Date(`${due}T00:00:00Z`).getTime()) / 86400000;
  return d > 0 ? Math.floor(d) : 0;
};
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class DrawerService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** 다섯 갈래를 읽어 한 모양으로 — GPAPACK 은 표가 없어 빠진다 (N-13) */
  private async approvalRows(): Promise<ApRow[]> {
    const rows: ApRow[] = [];

    for (const r of await this.q(
      `SELECT r.id, r.rpt_type, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state, r.reject_reason,
              ${kstAt(`COALESCE(r.sent_at, r.on_date::timestamptz)`)} AS at
         FROM rpt r WHERE r.state <> 'na'`,
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
      `SELECT q.id, q.req_type, q.state, q.reject_reason, q.staff_id, s.name AS by_name,
              ${kstAt(`q.created_at`)} AS at
         FROM req q LEFT JOIN staff s ON s.id = q.staff_id`,
    )) {
      rows.push({
        kind: 'req', id: Number(r.id),
        title: `${labelOf(REQ_TYPE_LABEL, String(r.req_type))} 요청`, sub: null,
        byId: num(r.staff_id), byName: str(r.by_name), at: String(r.at),
        state: toApState(str(r.state)), why: str(r.reject_reason), go: '/ops',
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

  async all(viewerId: number, canApprove: boolean, canSeeAll: boolean): Promise<DrawerDto> {
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
      overdueDays: r.done === true ? 0 : overdue(str(r.due_on)),
      // 출처가 있으면 원본으로 돌아갈 수 있다 (§15 규칙)
      go: r.mt_id || r.cpl_id ? '/ops' : r.cons_id ? '/consulting' : r.plan_id ? '/ops' : null,
    }));

    const notis = (await this.q(
      `SELECT n.id, n.body, n.link, n.to_id, n.read_at, f.name AS from_name,
              ${kstAt(`n.created_at`)} AS at
         FROM noti n LEFT JOIN staff f ON f.id = n.from_id
        WHERE $2::boolean OR n.to_id = $1
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC`,
      [viewerId, canSeeAll],
    )).map((r) => ({
      id: Number(r.id), body: String(r.body), fromName: str(r.from_name),
      toId: num(r.to_id), link: str(r.link), read: r.read_at !== null, at: String(r.at),
      tone: notiTone(str(r.link)),
    }));

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
        ORDER BY c.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), reqType: String(r.req_type), serId: num(r.ser_id),
      onDate: str(r.on_date), reason: str(r.reason), state: String(r.state),
      byName: str(r.by_name), applyAll: r.apply_all === true, at: String(r.at),
    }));

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
      approvals, todos, notis, members, tzGroups, kinds, changeReqs, zoomAccounts,
      tz: 'Asia/Seoul',
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
    return rows.length > 0;
  }

  /** §16 알림 읽음. 남의 알림은 읽음 처리되지 않는다 — 조용히 0건이 아니라 false 로 답한다 */
  async markNotiRead(id: number, viewerId: number): Promise<boolean> {
    const rows = await this.q(
      `UPDATE noti SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND to_id = $2 RETURNING id`,
      [id, viewerId],
    );
    return rows.length > 0;
  }

  /** §19 변경 요청 넣기 — 겹침 판정은 부르는 쪽(컨트롤러)이 스케줄에서 받아 온다 */
  async createChangeReq(byId: number, d: {
    reqType: string; serId?: number | null; onDate?: string | null;
    payload?: Record<string, unknown> | null; reason: string; applyAll?: boolean;
  }): Promise<number> {
    const rows = await this.q<{ id: string }>(
      // 상태는 **적지 않는다** — 표의 기본값('pending')이 낱말의 출처다.
      // 여기에 낱말을 다시 적으면 기본값이 바뀌는 날 두 곳이 갈린다.
      `INSERT INTO chreq (ser_id, on_date, req_type, payload, reason, by_id, apply_all)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [d.serId ?? null, d.onDate ?? null, d.reqType, JSON.stringify(d.payload ?? {}),
       d.reason, byId, d.applyAll === true],
    );
    return Number(rows[0].id);
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
