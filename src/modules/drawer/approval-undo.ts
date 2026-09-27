/** @file-guide
 * 목적: approval-undo.ts — §14 결재(요청 승인·반려 · 변경 요청 반영·반려) 되돌리기 토큰의 서명 · 읽기 (N-84)
 * 책임/재사용: 서명과 만료는 일정 되돌리기(`schedule.undo` 의 `sign` · `TTL_SECONDS`)를 그대로 쓴다. DB 쓰기·권한·신선도 판정은 DrawerService 가 한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 결재 되돌리기 토큰 (N-84 채택 · W11 — 「본인 · 10분 · 직전 하나」).
 *
 * 토큰은 **무엇을 어떻게 되돌릴지**를 서명해 들고 다닌다 — 서버에 따로 저장하지 않는다(일정 되돌리기와 같은 결정 · C87).
 * 화면은 토큰을 풀지 않는다. 만료 시각은 토큰 안의 `exp` 와 같은 값을 응답에 한 번 더 적어 보낸다.
 *
 * **서명은 일정 되돌리기와 같은 함수**이고 입력 앞에 `approval-undo.` 를 붙여 두 토큰이 서로를 흉내 내지 못하게 한다 —
 * 일정 토큰의 본문은 base64url 이라 `.` 이 들어갈 수 없으므로 두 서명의 입력이 겹치지 않는다.
 *
 * 한 토큰은 **그 처리 하나**만 되돌린다. 「직전 하나」는 신선도로 지킨다 — 그 사이 같은 대상이 바뀌었으면
 * (시급 줄이 더 생겼다 · 시간대가 또 바뀌었다 · 요청이 다시 처리됐다) 서버가 409 로 멈춘다.
 *
 * **한 번만 (W11 A' 후속 · v2)** — 토큰은 그 처리가 남긴 **감사 줄(`log.id`)** 에 묶인다. 그 줄 뒤에 같은 요청의
 * 결재 · 되돌리기 줄이 하나라도 있으면 409 다. 되돌린 뒤 다시 처리하면 상태만으로는 옛 토큰과 새 토큰을 가를 수 없었다
 * (같은 사람 · 같은 결정이면 상태가 같다) — 감사 줄의 차례가 그 둘을 가른다. v1 토큰은 받지 않는다(10분짜리라 잃는 것이 없다).
 */
import { timingSafeEqual } from 'node:crypto';
import { sign, TTL_SECONDS } from '../schedule/schedule.undo';

const VERSION = 2;
const DOMAIN = 'approval-undo.';

/** 요청(REQ) 승인이 실제로 바꾼 것 — 되돌릴 때 그대로 거꾸로 한다 */
export type ReqUndoEffect =
  | { kind: 'wage'; wageId: number; staffId: number; fromDate: string }
  | { kind: 'tz'; staffId: number; from: string | null; to: string }
  | { kind: 'gpa'; useId: number }
  | { kind: 'none' };

/** `logId` — 그 처리가 남긴 감사 줄(`log.id`). 이 줄 뒤에 같은 요청의 줄이 생기면 토큰은 끝난다(한 번만) */
export type ApprovalUndoPayload =
  | { v: typeof VERSION; actorId: number; exp: number; target: 'req'; id: number; decision: 'approve' | 'reject'; logId: number; effect: ReqUndoEffect }
  /** 변경 요청 — 반영이면 **일정 되돌리기 토큰을 그대로** 품는다(시간표 · 줌 배정은 그 토큰이 되돌린다) · 반려면 null */
  | { v: typeof VERSION; actorId: number; exp: number; target: 'chreq'; id: number; decision: 'approve' | 'reject'; logId: number; schedToken: string | null };

type Body<T> = T extends unknown ? Omit<T, 'v' | 'actorId' | 'exp'> : never;

/**
 * @param expiresAt 이미 정해진 만료가 있으면(변경 요청 반영 — 일정 토큰의 만료) 그것을 쓴다. 없으면 지금부터 10분.
 */
export function issueApprovalUndo(
  actorId: number, body: Body<ApprovalUndoPayload>, now = Date.now(), expiresAt?: string | null,
): { token: string; expiresAt: string } {
  const fallback = Math.floor(now / 1000) + TTL_SECONDS;
  const given = expiresAt ? Math.floor(Date.parse(expiresAt) / 1000) : NaN;
  // 두 토큰이 함께 끝나게 — 품은 일정 토큰보다 늦게 끝나면 그 사이에는 「되돌릴 수 있다」는 말이 거짓이 된다
  const exp = Number.isFinite(given) ? Math.min(given, fallback) : fallback;
  const payload = { v: VERSION, actorId, exp, ...body } as ApprovalUndoPayload;
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${encoded}.${sign(DOMAIN + encoded)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function isEffect(v: unknown): v is ReqUndoEffect {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (e.kind === 'none') return true;
  if (e.kind === 'wage') return isInt(e.wageId) && isInt(e.staffId) && isStr(e.fromDate);
  if (e.kind === 'tz') return isInt(e.staffId) && isStr(e.to) && (e.from === null || isStr(e.from));
  if (e.kind === 'gpa') return isInt(e.useId);
  return false;
}

/** 서명 · 모양 · 본인 · 만료를 모두 지난 토큰만 돌려준다. 하나라도 어긋나면 null — 이유를 밖에 흘리지 않는다 */
export function readApprovalUndo(token: string, actorId: number, now = Date.now()): ApprovalUndoPayload | null {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(DOMAIN + encoded));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (p.v !== VERSION || p.actorId !== actorId || !Number.isInteger(p.exp)) return null;
    if ((p.exp as number) < Math.floor(now / 1000)) return null;
    if (!isInt(p.id) || !isInt(p.logId) || (p.decision !== 'approve' && p.decision !== 'reject')) return null;
    if (p.target === 'req') return isEffect(p.effect) ? (p as unknown as ApprovalUndoPayload) : null;
    if (p.target === 'chreq') {
      return p.schedToken === null || isStr(p.schedToken) ? (p as unknown as ApprovalUndoPayload) : null;
    }
    return null;
  } catch {
    return null;
  }
}
