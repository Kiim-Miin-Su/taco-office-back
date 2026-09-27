/** @file-guide
 * 목적: schedule.undo.ts — 일정 직전 쓰기의 서명·압축 스냅숏과 재생 방어
 * 책임/재사용: State 직렬화·서명·검증만 소유한다. DB 쓰기/권한/투영은 ScheduleWriteService가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { State } from '../../lib/recurrence';

const VERSION = 1;
export const TTL_SECONDS = 10 * 60;
const MAX_UNCOMPRESSED = 1024 * 1024;

interface UndoPayload {
  v: typeof VERSION;
  actorId: number;
  exp: number;
  before: State;
  after: State;
}

const secret = () => process.env.JWT_SECRET ?? 'dev-only-change-me';
export const sign = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');

/** 같은 행 집합은 조회 순서가 달라도 같은 문자열이어야 stale 판정이 흔들리지 않는다. */
export function canonicalScheduleState(state: State): State {
  return {
    SER: [...state.SER].sort((a, b) => a.id - b.id),
    SER_STU: [...state.SER_STU].sort((a, b) => a.serId - b.serId || a.studentId - b.studentId),
    EXC: [...state.EXC]
      .map((row) => ({ ...row, stuOut: [...row.stuOut].sort((a, b) => a - b) }))
      .sort((a, b) => a.serId - b.serId || a.onDate.localeCompare(b.onDate)),
  };
}

/**
 * stale 판정 — **업무 값**만 견준다.
 * 예외 줄의 키는 (규칙, 원래 날짜)이고 `exc.id` 는 저장소가 붙인 번호일 뿐이다. 되돌리기가 지워졌던
 * 예외를 되살리면 번호가 새로 붙는데(persist 의 upsert), 그 번호까지 견주면 **앞 단계 토큰이
 * 「그 뒤 바뀌었다」로 잘못 막혀** 여러 단계 되돌리기(g1 S5)가 두 번째에서 멈춘다.
 * 규칙 id(SER.id)는 되살릴 때 그대로 지키므로(restoreSerIds) 견주는 값에 남긴다.
 */
const comparable = (state: State) => {
  const canon = canonicalScheduleState(state);
  return { ...canon, EXC: canon.EXC.map(({ id: _id, ...row }) => row) };
};

export function sameScheduleState(left: State, right: State): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

/** 토큰은 브라우저 메모리에만 머물며, 압축 뒤 HMAC으로 변조를 막는다. */
export function issueScheduleUndo(actorId: number, before: State, after: State, now = Date.now()): string {
  return issueScheduleUndoStep(actorId, before, after, now).token;
}

/**
 * 토큰과 **그 토큰이 끝나는 시각**을 함께 낸다 (g1 S5 「⟲ 되돌리기 ▾」 여러 단계).
 * 화면은 단계 목록에서 지난 것을 빼야 하는데, 10분이라는 수를 화면이 따로 들면 서버 규칙의 사본이 된다.
 * 그래서 만료는 토큰 안의 `exp` 와 **같은 값**을 ISO 로 한 번 더 적어 보낸다(토큰을 화면이 풀지 않게).
 */
export function issueScheduleUndoStep(
  actorId: number, before: State, after: State, now = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + TTL_SECONDS;
  const payload: UndoPayload = {
    v: VERSION,
    actorId,
    exp,
    before: canonicalScheduleState(before),
    after: canonicalScheduleState(after),
  };
  const body = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function isState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<State>;
  return Array.isArray(row.SER) && Array.isArray(row.SER_STU) && Array.isArray(row.EXC);
}

export function readScheduleUndo(token: string, actorId: number, now = Date.now()): UndoPayload | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return null;
  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const raw = inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: MAX_UNCOMPRESSED });
    const value = JSON.parse(raw.toString('utf8')) as Partial<UndoPayload>;
    if (value.v !== VERSION || value.actorId !== actorId || !Number.isInteger(value.exp)) return null;
    if (value.exp! < Math.floor(now / 1000) || !isState(value.before) || !isState(value.after)) return null;
    return value as UndoPayload;
  } catch {
    return null;
  }
}
