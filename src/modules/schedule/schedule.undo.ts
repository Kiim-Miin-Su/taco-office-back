/** @file-guide
 * 목적: schedule.undo.ts — 일정 직전 쓰기의 서명·압축 스냅숏과 재생 방어
 * 책임/재사용: State 직렬화·서명·검증만 소유한다. DB 쓰기/권한/투영은 ScheduleWriteService가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { State } from '../../lib/recurrence';

const VERSION = 1;
const TTL_SECONDS = 10 * 60;
const MAX_UNCOMPRESSED = 1024 * 1024;

interface UndoPayload {
  v: typeof VERSION;
  actorId: number;
  exp: number;
  before: State;
  after: State;
}

const secret = () => process.env.JWT_SECRET ?? 'dev-only-change-me';
const sign = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');

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

export function sameScheduleState(left: State, right: State): boolean {
  return JSON.stringify(canonicalScheduleState(left)) === JSON.stringify(canonicalScheduleState(right));
}

/** 토큰은 브라우저 메모리에만 머물며, 압축 뒤 HMAC으로 변조를 막는다. */
export function issueScheduleUndo(actorId: number, before: State, after: State, now = Date.now()): string {
  const payload: UndoPayload = {
    v: VERSION,
    actorId,
    exp: Math.floor(now / 1000) + TTL_SECONDS,
    before: canonicalScheduleState(before),
    after: canonicalScheduleState(after),
  };
  const body = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
  return `${body}.${sign(body)}`;
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
