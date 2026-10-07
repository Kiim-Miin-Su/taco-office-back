/** @file-guide
 * 목적: BO-09E-01 Kinder 1대1 순수 판정기를 PostgreSQL marker 이력·공용 transaction 잠금에 연결한다.
 * 책임/재사용: schedule/marker writer가 같은 lock·load·409 투영을 사용한다. 월 마감 공유 잠금은 호출자가 먼저 잡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ConflictException } from '@nestjs/common';
import type { State } from './recurrence';
import {
  assertKinderRosterState, KinderRosterConflict, type KinderMarkerEvent,
} from './kinder-roster';
import { lockMonthSensitiveWrite, type Queryable } from './month-close';

const KINDER_ROSTER_WRITE_LOCK = 'kinder_roster:all-marker-and-roster-writes';

/**
 * 권고안 채택(BO-09E-01): 월 마감 공유 잠금 뒤, 기존 SER/STU 행 잠금 전에 잡는 전역 배타 잠금이다.
 * marker 변경과 명단 변경을 한 줄로 세워 둘 다 오래된 상대 상태를 읽고 통과하는 경합을 막는다.
 */
export async function lockKinderRosterWrite(q: Queryable): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [KINDER_ROSTER_WRITE_LOCK]);
}

/** 모든 최상위 writer가 업무 행보다 먼저 호출하는 두 잠금의 단일 진입점. */
export async function lockKinderRosterPolicyWrite(q: Queryable): Promise<void> {
  await lockMonthSensitiveWrite(q);
  await lockKinderRosterWrite(q);
}

export async function loadKinderMarkerEvents(q: Queryable, studentIds: readonly number[]): Promise<KinderMarkerEvent[]> {
  if (!studentIds.length) return [];
  const rows = await q.query(
    `SELECT student_id, marked, effective_from, version
       FROM stu_kinder_marker
      WHERE student_id = ANY($1::bigint[])
      ORDER BY student_id,effective_from,version`,
    [[...new Set(studentIds)]],
  ) as Array<{ student_id: string; marked: boolean; effective_from: Date | string; version: number }>;
  return rows.map((row) => ({
    studentId: Number(row.student_id),
    marked: row.marked,
    effectiveFrom: row.effective_from instanceof Date ? row.effective_from.toISOString() : String(row.effective_from),
    version: Number(row.version),
  }));
}

export function throwKinderConflict(error: unknown): never {
  if (!(error instanceof KinderRosterConflict)) throw error;
  throw new ConflictException({
    code: error.code,
    message: error.message,
    serId: error.serId,
    onDate: error.onDate,
    date: error.date,
    conflictFrom: error.conflictFrom,
    conflictTo: error.conflictTo,
    studentIds: error.studentIds,
  });
}

export async function assertKinderRosterWrite(q: Queryable, state: Pick<State, 'SER' | 'SER_STU' | 'EXC'>): Promise<void> {
  const studentIds = state.SER_STU.map((row) => row.studentId);
  const markers = await loadKinderMarkerEvents(q, studentIds);
  try {
    assertKinderRosterState(state, markers);
  } catch (error) {
    throwKinderConflict(error);
  }
}
