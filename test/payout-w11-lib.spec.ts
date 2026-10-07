/** @file-guide
 * 목적: payout-w11-lib.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 M2 — DB 없이 보는 판정 넷 (N-93 가산 · N-51 보정 달 · N-94 줄 가림 · 권한 · 감사 줄).
 *
 * 가산은 **한 함수**(`lessonCompensation`)가 시트 · 확정 · 강사 히스토리에 같이 더한다 — 그 함수의 셈을 여기서 못 박는다.
 * 금액은 D1(§4-12) 값을 쓰되 **데이터로 넣지 않는다**(규칙 줄은 대표가 적는다) — 여기서는 셈만 본다.
 */
import {
  BONUS_D1_DEFAULTS, consecutiveGraceMinutes, correctionTargetMonth, lessonCompensation, nextMonth, payOf,
  payoutSettleLabel, payoutBreakdown, type BonusRuleRow, type PayoutLesson,
} from '../src/lib/payout-sheet';
import { ACCT_PRIVACY_KEYS, acctPrivacyAuditId, lineAmountVisible } from '../src/lib/acct-privacy';
import { AUDIT_WRITES } from '../src/lib/audit';
import { canCeoApproveCorrection, canCeoSetAcctPrivacy, ROLES } from '../src/common/perm';

describe('공용 급여 계산기 (BO-09D-02 · lib/payout-sheet.lessonCompensation)', () => {
  const rules: BonusRuleRow[] = [
    { kind: 'per_session', kindKey: 'mock', amount: 15000, fromDate: '2026-09-01' },
    { kind: 'per_session', kindKey: 'diagx', amount: 15000, fromDate: '2026-09-01' },
    { kind: 'per_session', kindKey: 'mock', amount: 0, fromDate: '2026-10-01' }, // 그 날부터 멈춤
    { kind: 'group_per_student', kindKey: null, amount: 5000, fromDate: '2026-09-01' },
    { kind: 'kinder_hourly', kindKey: null, amount: 10000, fromDate: '2026-09-01' },
  ];
  const lesson = (over: Partial<{ kindKey: string; onDate: string; durMin: number; bonusHeads: number; isKinder: boolean }> = {}) => ({
    kindKey: 'class', onDate: '2026-09-15', durMin: 60, bonusHeads: 1, isKinder: false, ...over,
  });

  it('진단·모의는 기본 시급·시간·학생 수·Kinder·그룹을 합산하지 않고 회차당 총 15,000원이다', () => {
    for (const kindKey of ['mock', 'diagx']) {
      const out = lessonCompensation(lesson({ kindKey, durMin: 120, bonusHeads: 3, isKinder: true }), 45000, rules);
      expect(out).toEqual({ pay: 0, bonus: 15000, parts: [{ kind: 'per_session', amount: 15000 }], unitRate: 0 });
    }
  });

  it('일반 그룹은 기존 학생당 시간 가산을 유지한다', () => {
    expect(lessonCompensation(lesson({ bonusHeads: 3, durMin: 120 }), 45000, rules)).toEqual({
      pay: 90000, bonus: 30000, parts: [{ kind: 'group_per_student', amount: 30000 }], unitRate: 45000,
    });
    expect(lessonCompensation(lesson({ bonusHeads: 1, durMin: 120 }), 45000, rules)?.bonus).toBe(0);
    // 90분 · 2명 — 시급처럼 한 번만 절사(payOf)
    expect(lessonCompensation(lesson({ bonusHeads: 2, durMin: 90 }), 45000, rules)?.bonus).toBe(payOf(10000, 90));
  });

  it('명시 Kinder 표식의 일반 class는 1명만 허용하고 기본 시급 +10,000원/시간이며 그룹 가산은 0이다', () => {
    expect(lessonCompensation(lesson({ isKinder: true, durMin: 90, bonusHeads: 1 }), 45000, rules)).toEqual({
      pay: 67500, bonus: 15000, parts: [{ kind: 'kinder_hourly', amount: 15000 }], unitRate: 45000,
    });
    expect(() => lessonCompensation(lesson({ isKinder: true, bonusHeads: 2 }), 45000, rules)).toThrow('KINDER_GROUP_CONFLICT');
  });

  it('학년·나이 추정 입력 없이 명시 표식이 false이면 일반 수업으로 계산한다', () => {
    expect(lessonCompensation(lesson({ isKinder: false }), 45000, rules)).toEqual({ pay: 45000, bonus: 0, parts: [], unitRate: 45000 });
  });

  it('D1 값은 칸을 미리 채울 값이다 — 원문 §56 세 칸(「한 번에」는 모의수업 · 진단고사 둘)', () => {
    expect(BONUS_D1_DEFAULTS).toEqual([
      { kind: 'per_session', kindKey: 'mock', amount: 15000 },
      { kind: 'per_session', kindKey: 'diagx', amount: 15000 },
      { kind: 'kinder_hourly', kindKey: null, amount: 10000 },
      { kind: 'group_per_student', kindKey: null, amount: 5000 },
    ]);
  });
});

describe('실제 접점 연강 유예 (BO-09D-02)', () => {
  it('같은 강사의 실제 종료와 다음 시작이 맞닿은 묶음만 마지막 종료 + 수업 수×1시간으로 계산한다', () => {
    const grace = consecutiveGraceMinutes([
      { key: 'a', startEpoch: 1000, endEpoch: 4600 },
      { key: 'b', startEpoch: 4600, endEpoch: 8200 },
      { key: 'gap', startEpoch: 8260, endEpoch: 11860 },
    ]);
    expect(grace.get('a')).toBe(180); // 첫 회차 종료→마지막 종료 60분 + 2시간 유예
    expect(grace.get('b')).toBe(120);
    expect(grace.get('gap')).toBe(0);
  });
});

describe('강사 히스토리 정산 종류별 근거 (N-93 · 강사 덱 29)', () => {
  const paid = (over: Partial<PayoutLesson>): PayoutLesson => ({
    serId: 1, onDate: '2026-09-15', date: '2026-09-15', startMin: 600, durMin: 60,
    kindKey: 'class', subKey: null, mode: 'offline', title: null,
    students: '김민준', studentCount: 1, repState: 'ok', canceled: false, submittedAt: '2026-09-15 12:00',
    pay: 45000, lateCut: 0, penaltyIfNow: null, bonus: 0, bonusParts: [], unitRate: 45000,
    settle: 'written', correctionOf: null, paidIn: null, frozen: false,
    ...over,
  });

  it('기본 시급과 Kinder·그룹·진단·모의 총액을 서버가 각각 합계한다', () => {
    const out = payoutBreakdown([
      paid({ serId: 10, durMin: 30, pay: 22500 }),
      paid({
        serId: 11, kindKey: 'mock', durMin: 60, pay: 0, bonus: 15000,
        bonusParts: [{ kind: 'per_session', amount: 15000 }], unitRate: 0,
      }),
      paid({
        serId: 12, kindKey: 'diagx', durMin: 90, pay: 0, bonus: 15000,
        bonusParts: [{ kind: 'per_session', amount: 15000 }], unitRate: 0,
      }),
      paid({
        serId: 13, durMin: 90, pay: 67500, bonus: 15000,
        bonusParts: [{ kind: 'kinder_hourly', amount: 15000 }],
      }),
    ]);
    expect(out.map((r) => [r.key, r.lessonCount, r.minutes, r.amount])).toEqual([
      ['general', 1, 30, 22500],
      ['kinder', 1, 90, 82500],
      ['group', 0, 0, 0],
      ['diag', 1, 90, 15000],
      ['mock', 1, 60, 15000],
      ['other', 0, 0, 0],
    ]);
    expect(out.reduce((sum, row) => sum + row.amount, 0)).toBe(135000);
  });

  it('정산에 들지 않는 미작성·취소 회차는 breakdown에 섞지 않는다', () => {
    const out = payoutBreakdown([
      paid({ settle: 'unwritten', pay: null, bonus: null }),
      paid({ settle: 'canceled', canceled: true, pay: null, bonus: null }),
    ]);
    expect(out.every((r) => r.lessonCount === 0 && r.minutes === 0 && r.amount === 0)).toBe(true);
  });
});

describe('보정 달 (N-51 「다음 미확정 달」)', () => {
  it('원래 달 다음부터 확정되지 않은 첫 달 — 사이 달이 확정이면 건너뛴다', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(correctionTargetMonth('2026-07', new Set(['2026-07']))).toBe('2026-08');
    expect(correctionTargetMonth('2026-07', new Set(['2026-07', '2026-08']))).toBe('2026-09');
  });

  it('갈래 이름은 서버 낱말 — 보정 줄은 원래 달, 넘어간 회차는 지급된 달을 말한다', () => {
    expect(payoutSettleLabel({ settle: 'correction', correctionOf: '2026-07', paidIn: null })).toBe('보정 · 7월 회차');
    expect(payoutSettleLabel({ settle: 'late', correctionOf: null, paidIn: null })).toBe('확정된 달 — 다음 달 보정');
    expect(payoutSettleLabel({ settle: 'late', correctionOf: null, paidIn: '2026-08' })).toBe('확정된 달 — 8월 보정 지급');
    expect(payoutSettleLabel({ settle: 'written', correctionOf: null, paidIn: null })).toBe('리포트 씀');
  });
});

describe('줄 가림 (N-94 · lib/acct-privacy.lineAmountVisible)', () => {
  it('금액 권한이 먼저 · 스위치가 켜지면 비공개 열람이나 본인만 · 꺼져 있으면 그대로', () => {
    expect(lineAmountVisible(false, false, true)).toBe(false);
    expect(lineAmountVisible(true, false, false)).toBe(true);
    expect(lineAmountVisible(true, true, false)).toBe(false);
    expect(lineAmountVisible(true, true, true)).toBe(true);
    expect(lineAmountVisible(true, true, false, true)).toBe(true); // 강사 본인의 정산
  });

  it('감사 줄의 entity_id 는 스위치 차례로 고정된다(1 시급 · 2 컨설팅)', () => {
    expect(ACCT_PRIVACY_KEYS).toEqual(['wage', 'consulting']);
    expect(acctPrivacyAuditId('wage')).toBe(1);
    expect(acctPrivacyAuditId('consulting')).toBe(2);
  });
});

describe('권한 줄 · 감사 줄 (N-51 · N-94 · N-73)', () => {
  it('보정 승인 · 비공개 지정은 대표 판정 줄이다 — 강사만 닫힌다(P1 동안 ceoGate)', () => {
    for (const r of ROLES) {
      expect([r, canCeoApproveCorrection(r)]).toEqual([r, r !== 'teacher']);
      expect([r, canCeoSetAcctPrivacy(r)]).toEqual([r, r !== 'teacher']);
    }
  });

  it('새 돈 쓰기 셋이 감사 목록에 있다 — 가산 규칙 · 비공개 스위치 · 보정 승인 (기존 줄은 그대로)', () => {
    const keys = AUDIT_WRITES.map((w) => w.key as string);
    for (const k of ['payout.bonus_rule', 'acct.privacy', 'payout.correction', 'expense.review']) expect(keys).toContain(k);
  });
});
