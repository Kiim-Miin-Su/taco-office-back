/** @file-guide
 * 목적: schedule-w11.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 스케줄 결정 채택 — 순수 규칙 (DB 없음).
 *
 *   N-56  회차 방식 전환 — 이번만/향후/모두 · 온라인이면 강의실을 비우고 줌을 붙인다 · 현장이면 줌을 푼다 · 함께 바뀐 것은 문장
 *   N-56  줌만 다른 회차의 예외는 다음 쓰기에서 지워지지 않는다(전에는 정리 규칙이 지워 배정이 사라졌다)
 *   N-56  「향후」로 가른 새 규칙이 규칙 단위 줌 계정을 물려받는다
 *   N-57  회차 메모 — 범위와 무관하게 그 회차 하나 · 휴강을 풀지 않는다 · 「모두」가 지우지 않는다
 *   N-73  감사 줄 — 규칙마다 한 줄 · 바뀐 것만 · 줌 배정(투영)은 싣지 않는다
 */
import * as R from '../src/lib/recurrence';
import type { State } from '../src/lib/recurrence';
import { scheduleAuditLines } from '../src/modules/schedule/schedule.audit';
import { OccurrencePatchDto } from '../src/modules/schedule/schedule.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/** 매주 월 10:00~11:00 현장(강의실 201) · 2026-08-03 시작 */
const offline = (): State => ({
  SER: [{
    id: 1, kind: 'regular', sub: null, mode: 'offline', title: '수학 A',
    teacherId: 11, roomId: 201, startMin: 600, endMin: 660,
    rrule: 'WEEKLY:MO', fromDate: '2026-08-03', toDate: null, zaccId: null,
  }],
  SER_STU: [{ serId: 1, studentId: 101 }],
  EXC: [],
});

/** 같은 규칙을 온라인(줌 계정 7)으로 */
const online = (): State => {
  const s = offline();
  s.SER[0] = { ...s.SER[0], mode: 'online', roomId: null, zaccId: 7 };
  return s;
};

const excAt = (s: State, serId: number, onDate: string) => s.EXC.find((e) => e.serId === serId && e.onDate === onDate);

describe('N-56 회차 방식 전환 — 리듀서', () => {
  it('이번만 온라인으로 — 규칙은 그대로, 그 회차만 강의실을 비우고 줌을 붙인다 · 문장으로 알린다', () => {
    const a = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'online', zaccId: 5, __onDate: '2026-08-10' } });
    expect(a.SER[0]).toMatchObject({ mode: 'offline', roomId: 201, zaccId: null });
    expect(excAt(a, 1, '2026-08-10')).toMatchObject({ mode: 'online', roomSet: true, roomId: null, zaccId: 5 });
    const [o] = R.occ('2026-08-10', a);
    expect(o).toMatchObject({ mode: 'online', roomId: null });
    expect(R.occ('2026-08-17', a)[0]).toMatchObject({ mode: 'offline', roomId: 201 });
    expect(a.__log).toEqual(['2026-08-10 회차만 바꿨습니다', '온라인 수업으로 바꿨습니다', '강의실을 비웠습니다', '줌 계정을 배정했습니다']);
    // 내부 값(행 번호 · 표 이름 · 칸 이름)은 문장에 없다 — 날짜만 사람 말로 적는다
    expect(a.__log.join(' ')).not.toMatch(/EXC|SER|room_id|zacc|\(\d+,/);
  });

  it('규칙의 방식으로 돌아가면 예외를 비운다 — 강의실은 규칙을 따르고 줌은 풀린다', () => {
    const on = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'online', zaccId: 5, __onDate: '2026-08-10' } });
    const back = R.applyEdit(on, { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'offline', __onDate: '2026-08-10' } });
    // 남은 효과가 없으니 예외 행 자체가 사라진다
    expect(excAt(back, 1, '2026-08-10')).toBeUndefined();
    expect(R.occ('2026-08-10', back)[0]).toMatchObject({ mode: 'offline', roomId: 201 });
    expect(back.__log).toEqual(['2026-08-10 회차만 바꿨습니다', '현장 수업으로 바꿨습니다', '줌 계정을 풀었습니다']);
  });

  it('온라인 규칙의 한 회차를 현장으로 — 회차 방식은 offline, 그 회차에는 줌이 없다', () => {
    const a = R.applyEdit(online(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'offline', roomId: 202, __onDate: '2026-08-10' } });
    expect(excAt(a, 1, '2026-08-10')).toMatchObject({ mode: 'offline', roomSet: true, roomId: 202, zaccId: null });
    expect(R.occ('2026-08-10', a)[0]).toMatchObject({ mode: 'offline', roomId: 202 });
    expect(a.__log).toContain('줌 계정을 풀었습니다');
  });

  it('모두 — 규칙이 온라인이 되고 회차마다 정한 강의실 예외는 규칙에 맞춘다', () => {
    const s = offline();
    s.EXC.push({
      id: 9, serId: 1, onDate: '2026-08-17', canceled: false, newDate: null, startMin: null, endMin: null,
      teacherSet: false, teacherId: null, roomSet: true, roomId: 203, reason: null,
      cancelKind: null, cancelTreat: null, makeupSerId: null, stuOut: [], mode: null, memo: '메모는 남는다', zaccId: null,
    });
    const a = R.applyEdit(s, { serId: 1, onDate: '2026-08-10', scope: 'all', patch: { mode: 'online', zaccId: 4, __onDate: '2026-08-10' } });
    expect(a.SER[0]).toMatchObject({ mode: 'online', roomId: null, zaccId: 4 });
    // 강의실 예외는 풀리고 메모는 남는다 — 메모는 「모두」가 초기화하는 칸이 아니다 (N-57)
    expect(excAt(a, 1, '2026-08-17')).toMatchObject({ roomSet: false, roomId: null, memo: '메모는 남는다' });
    expect(a.__log).toEqual(expect.arrayContaining(['온라인 수업으로 바꿨습니다', '강의실을 비웠습니다', '줌 계정을 배정했습니다']));
  });

  it('향후 — 갈라진 새 규칙이 줌 계정을 물려받는다 (전에는 분할 뒤 회차가 계정을 잃었다)', () => {
    const a = R.applyEdit(online(), { serId: 1, onDate: '2026-08-17', scope: 'future', patch: { startMin: 630, endMin: 690, __onDate: '2026-08-17' } });
    const copy = a.SER.find((s) => s.id !== 1)!;
    expect(copy).toMatchObject({ fromDate: '2026-08-17', mode: 'online', zaccId: 7, startMin: 630 });
    expect(a.SER.find((s) => s.id === 1)).toMatchObject({ toDate: '2026-08-16', zaccId: 7 });
    expect(a.__log[0]).toBe('2026-08-17 부터 규칙을 나눴습니다');
  });

  it('줌만 다른 회차의 예외는 명단 쓰기 뒤에도 남는다 — 정리 규칙이 효과로 센다', () => {
    const s = online();
    s.EXC.push({
      id: 9, serId: 1, onDate: '2026-08-10', canceled: false, newDate: null, startMin: null, endMin: null,
      teacherSet: false, teacherId: null, roomSet: false, roomId: null, reason: '줌 계정 배정',
      cancelKind: null, cancelTreat: null, makeupSerId: null, stuOut: [], mode: null, memo: null, zaccId: 3,
    });
    const a = R.applyRoster(s, { serId: 1, onDate: '2026-08-17', studentId: 101, op: 'dropOnce' });
    expect(excAt(a, 1, '2026-08-10')).toMatchObject({ zaccId: 3 });
  });

  it('복사는 보이는 방식 그대로 — 온라인으로 바꾼 회차를 복사하면 온라인이다', () => {
    const on = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'online', __onDate: '2026-08-10' } });
    const [o] = R.occ('2026-08-10', on);
    expect(R.copyPayload(on, o)).toMatchObject({ mode: 'online', roomId: null });
  });

  it('보강 이관은 그 회차의 방식을 물려받는다', () => {
    const on = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'online', __onDate: '2026-08-10' } });
    const d = R.applyDelete(on, {
      serId: 1, onDate: '2026-08-10', scope: 'this',
      cancel: { kind: 'teacher_absent', treat: 'makeup' },
      makeup: { date: '2026-08-12', startMin: 600, endMin: 660 },
    });
    expect(d.SER.find((s) => s.rrule === 'ONCE')).toMatchObject({ mode: 'online', roomId: null });
  });
});

describe('N-57 회차 메모 — 리듀서', () => {
  it('메모만 보내면 「향후」여도 규칙을 가르지 않고 그 회차에만 붙는다', () => {
    const a = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-17', scope: 'future', patch: { memo: '  오답 리뷰 우선  ', __onDate: '2026-08-17' } });
    expect(a.SER).toHaveLength(1);
    expect(a.__effScope).toBe('this');
    expect(excAt(a, 1, '2026-08-17')).toMatchObject({ memo: '오답 리뷰 우선', canceled: false });
    expect(a.__log).toEqual(['회차 메모를 적었습니다']);
  });

  it('휴강 회차에 메모를 적어도 휴강이 풀리지 않는다', () => {
    const canceled = R.applyDelete(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', cancel: { kind: 'academy', treat: 'carry' } });
    const a = R.applyEdit(canceled, { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { memo: '보강 날짜 조율 중', __onDate: '2026-08-10' } });
    expect(excAt(a, 1, '2026-08-10')).toMatchObject({ canceled: true, cancelKind: 'academy', memo: '보강 날짜 조율 중' });
  });

  it('빈 메모는 지운 것이다 — 남은 효과가 없으면 예외 행도 사라진다', () => {
    const a = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { memo: '노트', __onDate: '2026-08-10' } });
    const b = R.applyEdit(a, { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { memo: '   ', __onDate: '2026-08-10' } });
    expect(excAt(b, 1, '2026-08-10')).toBeUndefined();
    expect(b.__log).toEqual(['회차 메모를 지웠습니다']);
  });

  it('시간을 모두 바꾸며 메모를 적으면 규칙은 바뀌고 메모는 그 회차에만 남는다', () => {
    const a = R.applyEdit(offline(), { serId: 1, onDate: '2026-08-10', scope: 'all', patch: { startMin: 660, endMin: 720, memo: '이번만', __onDate: '2026-08-10' } });
    expect(a.SER[0]).toMatchObject({ startMin: 660 });
    expect(a.EXC.filter((e) => e.memo)).toEqual([expect.objectContaining({ onDate: '2026-08-10', memo: '이번만' })]);
  });
});

describe('N-73 감사 줄 — 규칙마다 한 줄 · 바뀐 것만', () => {
  it('이번만 — 그 규칙 한 줄 · 예외는 그 날짜만 · 줌 배정은 싣지 않는다', () => {
    const before = offline();
    const after = R.applyEdit(before, { serId: 1, onDate: '2026-08-10', scope: 'this', patch: { mode: 'online', zaccId: 5, __onDate: '2026-08-10' } });
    const lines = scheduleAuditLines(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0].serId).toBe(1);
    expect(lines[0].before).toEqual({ exc: { '2026-08-10': null } });
    expect(lines[0].after).toEqual({ exc: { '2026-08-10': expect.objectContaining({ mode: 'online', roomSet: true, roomId: null }) } });
    expect(JSON.stringify(lines[0])).not.toContain('zaccId');
  });

  it('향후 — 원래 규칙과 새 규칙 두 줄 (만들기는 before 없음)', () => {
    const before = offline();
    const after = R.applyEdit(before, { serId: 1, onDate: '2026-08-17', scope: 'future', patch: { startMin: 630, endMin: 690, __onDate: '2026-08-17' } });
    const lines = scheduleAuditLines(before, after);
    expect(lines.map((l) => l.serId)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ before: { toDate: null }, after: { toDate: '2026-08-16' } });
    expect(lines[1].before).toBeUndefined();
    expect(lines[1].after).toMatchObject({ fromDate: '2026-08-17', startMin: 630, roster: [{ studentId: 101, fromDate: null, toDate: null }] });
  });

  it('바뀐 것이 없으면 줄이 없다', () => {
    expect(scheduleAuditLines(offline(), offline())).toEqual([]);
  });
});

describe('OccurrencePatchDto — 방식·메모 입력', () => {
  const check = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(OccurrencePatchDto, { scope: 'this', onDate: '2026-08-10', ...body }))).map((e) => e.property);

  it('방식은 두 낱말만 — null 은 받지 않는다(규칙으로 돌리려면 규칙의 방식을 보낸다)', async () => {
    expect(await check({ mode: 'online' })).toEqual([]);
    expect(await check({ mode: 'hybrid' })).toEqual(['mode']);
    expect(await check({ mode: null })).toEqual(['mode']);
  });

  it('메모는 200자까지 · null 은 지우기', async () => {
    expect(await check({ memo: 'x'.repeat(200) })).toEqual([]);
    expect(await check({ memo: 'x'.repeat(201) })).toEqual(['memo']);
    expect(await check({ memo: null })).toEqual([]);
  });

  it('줌 계정은 안전 정수 id 또는 null', async () => {
    expect(await check({ mode: 'online', zaccId: 3 })).toEqual([]);
    expect(await check({ mode: 'online', zaccId: null })).toEqual([]);
    expect(await check({ mode: 'online', zaccId: 0 })).toEqual(['zaccId']);
  });
});
