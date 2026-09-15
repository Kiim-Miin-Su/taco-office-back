/** @file-guide
 * 목적: schedule-undo.spec.ts — 일정 undo 토큰의 서명·actor·만료·정규화 방어
 * 책임/재사용: 실제 issue/read/canonical 함수를 사용하며 DB 복원은 schedule-write 통합 스위트가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import type { State } from '../src/lib/recurrence';
import { issueScheduleUndo, readScheduleUndo, sameScheduleState } from '../src/modules/schedule/schedule.undo';

const state = (): State => ({
  SER: [{ id: 7, kind: 'class', sub: null, mode: 'offline', title: '', teacherId: 2, roomId: 1,
    startMin: 600, endMin: 660, rrule: 'ONCE', fromDate: '2026-09-15', toDate: '2026-09-15' }],
  SER_STU: [{ serId: 7, studentId: 2 }, { serId: 7, studentId: 1 }],
  EXC: [],
});

describe('일정 실행 취소 토큰', () => {
  it('같은 actor는 압축 스냅숏을 읽고 배열 순서는 stale 변경으로 보지 않는다', () => {
    const before = state();
    const after = state();
    after.SER[0].startMin = 630;
    const token = issueScheduleUndo(2, before, after, 1_000_000);
    const read = readScheduleUndo(token, 2, 1_001_000);
    expect(read?.before.SER[0].startMin).toBe(600);
    expect(read?.after.SER[0].startMin).toBe(630);
    expect(sameScheduleState(before, { ...before, SER_STU: [...before.SER_STU].reverse() })).toBe(true);
  });

  it('다른 actor·변조·10분 만료 토큰은 읽지 않는다', () => {
    const token = issueScheduleUndo(2, state(), state(), 1_000_000);
    expect(readScheduleUndo(token, 3, 1_001_000)).toBeNull();
    expect(readScheduleUndo(`${token.slice(0, -1)}x`, 2, 1_001_000)).toBeNull();
    expect(readScheduleUndo(token, 2, 1_601_000)).toBeNull();
  });

  it('같은 행의 값이 달라지면 stale 상태다', () => {
    const left = state();
    const right = state();
    right.SER[0].roomId = 9;
    expect(sameScheduleState(left, right)).toBe(false);
  });
});
