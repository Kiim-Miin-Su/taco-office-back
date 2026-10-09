/** @file-guide
 * 목적: BOC-11C 연체 수강 정지와 schedule writer를 같은 잠금·최종 상태 검사로 연결한다.
 * 책임/재사용: 회계 상태 전이와 schedule create/paste/move/patch/roster/undo가 이 파일의 직렬화·409를 공유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11C-DELINQUENCY-SUSPENSION-2026-10-09.md
 */
import { ConflictException } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';
import type { Exc, Ser, SerStu, State } from './recurrence';

const LOCK = 'delinquency-suspension:state-and-schedule';

export async function lockDelinquencyScheduleWrite(q: Pick<QueryRunner, 'query'>): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK]);
}

const rosterKey = (row: SerStu): string => `${row.serId}:${row.studentId}`;
const excKey = (row: Exc): string => `${row.serId}:${row.onDate}`;
const temporal = (row: Ser): unknown[] => [row.startMin, row.endMin, row.rrule, row.fromDate, row.toDate];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function rosterExpanded(before: SerStu | undefined, after: SerStu): boolean {
  if (!before) return true;
  const beforeFrom = before.fromDate ?? '0001-01-01';
  const afterFrom = after.fromDate ?? '0001-01-01';
  const beforeTo = before.toDate ?? '9999-12-31';
  const afterTo = after.toDate ?? '9999-12-31';
  return afterFrom < beforeFrom || afterTo > beforeTo;
}

function exceptionExpands(before: Exc | undefined, after: Exc | undefined, studentId: number): boolean {
  if (!before && !after) return false;
  if (!before && after) {
    if (after.canceled) return false;
    if ((after.stuOut ?? []).includes(studentId)) return false;
    return after.newDate !== null || after.startMin !== null || after.endMin !== null;
  }
  if (before && !after) {
    return before.canceled || (before.stuOut ?? []).includes(studentId);
  }
  const b = before!;
  const a = after!;
  if (b.canceled && !a.canceled) return true;
  if ((b.stuOut ?? []).includes(studentId) && !(a.stuOut ?? []).includes(studentId)) return true;
  if (a.canceled || (a.stuOut ?? []).includes(studentId)) return false;
  return !same([b.newDate, b.startMin, b.endMin], [a.newDate, a.startMin, a.endMin]);
}

/**
 * 권고안: 기존 일정·취소·학생 제거는 보존/허용하고, 정지 뒤 새로운 시간 약속만 막는다.
 * 정책을 바꾸면 DTO/OpenAPI·Front 설명·migration trigger·시나리오·portfolio를 함께 바꾼다.
 */
export async function assertNoSuspendedScheduleExpansion(
  q: Pick<QueryRunner, 'query'>, before: State, after: State,
): Promise<void> {
  const studentIds = [...new Set([...before.SER_STU, ...after.SER_STU].map((row) => row.studentId))];
  if (!studentIds.length) return;
  const suspendedRows = await q.query(
    `SELECT student_id FROM delinquency_suspension WHERE state='suspended' AND student_id=ANY($1::bigint[])`,
    [studentIds],
  ) as Array<{ student_id: string }>;
  const suspended = new Set(suspendedRows.map((row) => Number(row.student_id)));
  if (!suspended.size) return;

  const beforeRoster = new Map(before.SER_STU.map((row) => [rosterKey(row), row]));
  const beforeSer = new Map(before.SER.map((row) => [row.id, row]));
  const afterSer = new Map(after.SER.map((row) => [row.id, row]));
  const beforeExc = new Map(before.EXC.map((row) => [excKey(row), row]));
  const afterExc = new Map(after.EXC.map((row) => [excKey(row), row]));

  for (const studentId of suspended) {
    for (const row of after.SER_STU.filter((item) => item.studentId === studentId)) {
      if (rosterExpanded(beforeRoster.get(rosterKey(row)), row)) throwBlocked(studentId);
    }
    const relatedSeries = new Set([
      ...before.SER_STU.filter((row) => row.studentId === studentId).map((row) => row.serId),
      ...after.SER_STU.filter((row) => row.studentId === studentId).map((row) => row.serId),
    ]);
    for (const serId of relatedSeries) {
      const b = beforeSer.get(serId);
      const a = afterSer.get(serId);
      if (b && a && !same(temporal(b), temporal(a))) {
        const shortenedOnly = same(temporal(b).slice(0, 4), temporal(a).slice(0, 4))
          && (a.toDate ?? '9999-12-31') < (b.toDate ?? '9999-12-31');
        if (!shortenedOnly) throwBlocked(studentId);
      }
      const days = new Set([
        ...before.EXC.filter((row) => row.serId === serId).map(excKey),
        ...after.EXC.filter((row) => row.serId === serId).map(excKey),
      ]);
      for (const key of days) {
        if (exceptionExpands(beforeExc.get(key), afterExc.get(key), studentId)) throwBlocked(studentId);
      }
    }
  }
}

function throwBlocked(studentId: number): never {
  throw new ConflictException({
    code: 'DELINQUENCY_SCHEDULE_BLOCKED',
    message: '연체 수강 정지 중인 학생에게 새 일정·이동·복원·명단 추가를 저장할 수 없습니다',
    studentId,
  });
}
