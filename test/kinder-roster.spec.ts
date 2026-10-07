/** @file-guide
 * 목적: BO-09E-01 Kinder 1대1 공통 판정의 반복규칙·예외·표식 효력 회귀를 검증한다.
 * 책임/재사용: 제품의 assertKinderRosterState를 직접 호출하며 별도 판정식을 테스트에 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { assertKinderRosterState, type KinderMarkerEvent } from '../src/lib/kinder-roster';
import type { State } from '../src/lib/recurrence';

const base = (): State => ({
  SER: [{
    id: 1, kind: 'class', sub: null, mode: 'offline', title: 'Kinder 수업',
    teacherId: 11, roomId: 21, startMin: 600, endMin: 660,
    rrule: 'WEEKLY:MO', fromDate: '2026-10-12', toDate: null,
  }],
  SER_STU: [{ serId: 1, studentId: 101 }],
  EXC: [],
});

const marker = (
  studentId: number,
  marked = true,
  effectiveFrom = '2026-10-08T00:00:00.000Z',
  version = 1,
): KinderMarkerEvent => ({ studentId, marked, effectiveFrom, version });

describe('BO-09E-01 Kinder roster invariant', () => {
  it('명시 Kinder 일반 class 1명만 허용하고 학년·이름은 판정에 쓰지 않는다', () => {
    expect(() => assertKinderRosterState(base(), [marker(101)])).not.toThrow();
    const two = base();
    two.SER_STU.push({ serId: 1, studentId: 102 });
    expect(() => assertKinderRosterState(two, [])).not.toThrow();
  });

  it('명시 Kinder가 든 일반 class 2명은 원래·실제 날짜와 충돌기간을 담아 거절한다', () => {
    const state = base();
    state.SER_STU.push({ serId: 1, studentId: 102, fromDate: '2026-10-12', toDate: '2027-12-31' });
    expect(() => assertKinderRosterState(state, [marker(101)])).toThrow(expect.objectContaining({
      code: 'KINDER_GROUP_CONFLICT', serId: 1, onDate: '2026-10-12', date: '2026-10-12',
      conflictFrom: '2026-10-12', conflictTo: '2027-12-31', studentIds: [101, 102],
    }));
  });

  it('진단 그룹은 Kinder 표시만으로 금지하지 않는다', () => {
    const state = base();
    state.SER[0]!.kind = 'diagnostic';
    state.SER_STU.push({ serId: 1, studentId: 102 });
    expect(() => assertKinderRosterState(state, [marker(101)])).not.toThrow();
  });

  it('이동한 회차는 실제 날짜·시각의 표식 version을 쓰고 원래 날짜를 함께 보고한다', () => {
    const state = base();
    state.SER[0]!.toDate = '2026-10-12';
    state.SER_STU.push({ serId: 1, studentId: 102 });
    state.EXC.push({
      id: 1, serId: 1, onDate: '2026-10-12', canceled: false,
      newDate: '2026-10-20', startMin: 720, endMin: 780,
      teacherSet: false, teacherId: null, roomSet: false, roomId: null,
      reason: null, cancelKind: null, cancelTreat: null, makeupSerId: null, stuOut: [],
    });
    expect(() => assertKinderRosterState(state, [marker(101, true, '2026-10-20T02:59:59.000Z')]))
      .toThrow(expect.objectContaining({ onDate: '2026-10-12', date: '2026-10-20' }));
    expect(() => assertKinderRosterState(state, [marker(101, true, '2026-10-20T03:00:01.000Z')]))
      .not.toThrow();
  });

  it('90일 투영 밖에서 시작하는 명단 충돌도 반복규칙 원본으로 찾는다', () => {
    const state = base();
    state.SER_STU.push({ serId: 1, studentId: 102, fromDate: '2028-01-03', toDate: null });
    expect(() => assertKinderRosterState(state, [marker(101)]))
      .toThrow(expect.objectContaining({ onDate: '2028-01-03', studentIds: [101, 102] }));
  });

  it('취소·이 회차 제외·후속 일반 표식은 최종 상태대로 판정한다', () => {
    const state = base();
    state.SER_STU.push({ serId: 1, studentId: 102 });
    state.EXC.push({
      id: 1, serId: 1, onDate: '2026-10-12', canceled: false, newDate: null,
      startMin: null, endMin: null, teacherSet: false, teacherId: null,
      roomSet: false, roomId: null, reason: null, cancelKind: null, cancelTreat: null,
      makeupSerId: null, stuOut: [102],
    });
    expect(() => assertKinderRosterState(state, [
      marker(101, true, '2026-10-08T00:00:00.000Z', 1),
      marker(101, false, '2026-10-13T00:00:00.000Z', 2),
    ])).not.toThrow();
  });
});
