/** @file-guide
 * 목적: guides-deadline.spec.ts — §43 안내 기한(N-89) 판정 한 곳의 순수 회귀 (W11 · R2).
 * 책임/재사용: guide-deadline · lib/kst 의 공개 함수만 부른다. 원문 §43 두 줄(5시간 남음 · 23시간 남음)을 그대로 재현한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { GUIDE_LADDER, guideDeadline, guideLeftLabel } from '../src/modules/guides/guide-deadline';
import { kstMidnightMs, minutesUntil } from '../src/lib/kst';

/** 원문 §43 의 「오늘」 — 2026-08-21(금) 11:00 KST */
const NOW = Date.parse('2026-08-21T11:00:00+09:00');

describe('§43 안내 기한 — N-89 (첫 수업 시작까지 · 사다리 하루 · 6시간 · 3시간)', () => {
  it('원문 첫 줄 — 16:00 수업, 5시간 남음: 하루 · 6시간은 지났고 3시간은 남았다 → 「마감 지남」', () => {
    const d = guideDeadline('2026-08-21T16:00:00+09:00', '2026-08-21', NOW)!;
    expect(d).toMatchObject({ basis: 'lesson', minutesLeft: 300, leftLabel: '5시간 남음', urgency: 'overdue', urgencyLabel: '마감 지남' });
    expect(d.ladder).toEqual([
      { key: 'day', label: '하루', passed: true },
      { key: 'h6', label: '6시간', passed: true },
      { key: 'h3', label: '3시간', passed: false },
    ]);
  });

  it('원문 둘째 줄 — 다음 날 10:00 수업, 23시간 남음: 하루만 지났다 → 「오늘 안에」', () => {
    const d = guideDeadline('2026-08-22T10:00:00+09:00', '2026-08-22', NOW)!;
    expect(d).toMatchObject({ minutesLeft: 23 * 60, leftLabel: '23시간 남음', urgency: 'today', urgencyLabel: '오늘 안에' });
    expect(d.ladder.map((step) => step.passed)).toEqual([true, false, false]);
  });

  it('하루보다 멀면 칸이 다 남고 긴급도가 없다 · 이틀 넘게 남으면 날로 센다', () => {
    const d = guideDeadline('2026-08-25T10:00:00+09:00', null, NOW)!;
    expect(d).toMatchObject({ urgency: 'none', urgencyLabel: null, leftLabel: '3일 남음' });
    expect(d.ladder.every((step) => !step.passed)).toBe(true);
  });

  it('회차가 없으면 기한 날 00:00 KST 가 기준이다', () => {
    const d = guideDeadline(null, '2026-08-23', NOW)!;
    expect(d).toMatchObject({ basis: 'due', startAt: '2026-08-23T00:00:00+09:00', minutesLeft: 37 * 60, leftLabel: '37시간 남음' });
  });

  it('지났으면 음수와 「지남」 — 시작을 30초 넘겼으면 이미 지난 것이다', () => {
    expect(guideDeadline('2026-08-21T10:59:30+09:00', null, NOW)).toMatchObject({ minutesLeft: -1, leftLabel: '1분 지남', urgency: 'overdue' });
    expect(guideDeadline('2026-08-18T11:00:00+09:00', null, NOW)).toMatchObject({ leftLabel: '3일 지남' });
    expect(guideDeadline('2026-08-21T10:15:00+09:00', null, NOW)).toMatchObject({ leftLabel: '45분 지남' });
  });

  it('칸의 경계 — 정확히 6시간이면 6시간 칸이 지난 것이고 5시간 59분 30초는 내림해 5시간이다', () => {
    expect(guideDeadline('2026-08-21T17:00:00+09:00', null, NOW)).toMatchObject({ minutesLeft: 360, urgency: 'overdue' });
    expect(guideDeadline('2026-08-21T17:01:00+09:00', null, NOW)).toMatchObject({ minutesLeft: 361, urgency: 'today' });
    expect(guideDeadline('2026-08-21T16:59:30+09:00', null, NOW)).toMatchObject({ minutesLeft: 359, leftLabel: '5시간 남음' });
  });

  it('기준이 없으면 짓지 않는다(null) · 날짜 모양이 아니면 null', () => {
    expect(guideDeadline(null, null, NOW)).toBeNull();
    expect(guideDeadline(null, '2026-02-30', NOW)).toBeNull();
    expect(guideDeadline('not-a-time', 'nope', NOW)).toBeNull();
  });

  it('사다리 칸 이름은 원문 머리 그대로다', () => {
    expect(GUIDE_LADDER.map((step) => step.label).join(' · ')).toBe('하루 · 6시간 · 3시간');
    expect(guideLeftLabel(0)).toBe('0분 남음');
    expect(guideLeftLabel(47 * 60 + 59)).toBe('47시간 남음');
    expect(guideLeftLabel(48 * 60)).toBe('2일 남음');
  });

  it('lib/kst — 그 날의 KST 00:00 과 남은 분(내림)', () => {
    expect(new Date(kstMidnightMs('2026-08-21')).toISOString()).toBe('2026-08-20T15:00:00.000Z');
    expect(Number.isNaN(kstMidnightMs('2026-13-01'))).toBe(true);
    expect(minutesUntil(NOW + 90_000, NOW)).toBe(1);
    expect(minutesUntil(NOW - 30_000, NOW)).toBe(-1);
  });
});
