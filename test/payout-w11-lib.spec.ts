/** @file-guide
 * 목적: payout-w11-lib.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 M2 — DB 없이 보는 판정 넷 (N-93 가산 · N-51 보정 달 · N-94 줄 가림 · 권한 · 감사 줄).
 *
 * 가산은 **한 함수**(`lessonBonus`)가 시트 · 확정 · 강사 히스토리에 같이 더한다 — 그 함수의 셈을 여기서 못 박는다.
 * 금액은 D1(§4-12) 값을 쓰되 **데이터로 넣지 않는다**(규칙 줄은 대표가 적는다) — 여기서는 셈만 본다.
 */
import {
  BONUS_D1_DEFAULTS, KINDER_MARKER_EXISTS, correctionTargetMonth, lessonBonus, nextMonth, payOf, payoutSettleLabel,
  payoutBreakdown, type BonusRuleRow, type PayoutLesson,
} from '../src/lib/payout-sheet';
import { ACCT_PRIVACY_KEYS, acctPrivacyAuditId, lineAmountVisible } from '../src/lib/acct-privacy';
import { AUDIT_WRITES } from '../src/lib/audit';
import { canCeoApproveCorrection, canCeoSetAcctPrivacy, ROLES } from '../src/common/perm';

describe('가산 한 함수 (N-93 · lib/payout-sheet.lessonBonus)', () => {
  const rules: BonusRuleRow[] = [
    { kind: 'per_session', kindKey: 'mock', amount: 15000, fromDate: '2026-09-01' },
    { kind: 'per_session', kindKey: 'mock', amount: 0, fromDate: '2026-10-01' }, // 그 날부터 멈춤
    { kind: 'group_per_student', kindKey: null, amount: 5000, fromDate: '2026-09-01' },
    { kind: 'kinder_hourly', kindKey: null, amount: 10000, fromDate: '2026-09-01' },
  ];
  const lesson = (over: Partial<{ kindKey: string; onDate: string; durMin: number; bonusHeads: number }> = {}) => ({
    kindKey: 'class', onDate: '2026-09-15', durMin: 60, bonusHeads: 1, ...over,
  });

  it('「한 번에」는 그 수업 종류의 줄이 있으면 회차마다 그 금액 — 다른 종류 · 적용일 전에는 없다', () => {
    expect(lessonBonus(lesson({ kindKey: 'mock' }), rules)).toEqual({ total: 15000, parts: [{ kind: 'per_session', amount: 15000 }] });
    expect(lessonBonus(lesson({ kindKey: 'class' }), rules).total).toBe(0);
    expect(lessonBonus(lesson({ kindKey: 'mock', onDate: '2026-08-31' }), rules).total).toBe(0);
    // 금액 0 인 새 줄은 「그 날부터 멈춤」 — 지난 줄을 고치지 않고 새 줄로 바꾼다
    expect(lessonBonus(lesson({ kindKey: 'mock', onDate: '2026-10-02' }), rules).total).toBe(0);
  });

  it('그룹은 그날 학생이 둘 이상일 때 (금액 × 학생 수)를 시급처럼 시간에 곱한다 — 강사 덱 §32 「2시간 · 학생당 5,000 · 3명」 = 30,000', () => {
    expect(lessonBonus(lesson({ bonusHeads: 3, durMin: 120 }), rules)).toEqual({ total: 30000, parts: [{ kind: 'group_per_student', amount: 30000 }] });
    expect(lessonBonus(lesson({ bonusHeads: 1, durMin: 120 }), rules).total).toBe(0);
    // 90분 · 2명 — 시급처럼 한 번만 절사(payOf)
    expect(lessonBonus(lesson({ bonusHeads: 2, durMin: 90 }), rules).total).toBe(payOf(10000, 90));
    // 쌓인다 — 모의수업이 그룹이면 둘 다
    expect(lessonBonus(lesson({ kindKey: 'mock', bonusHeads: 2 }), rules).total).toBe(15000 + 10000);
  });

  it('Kinder 는 수업을 가를 표시가 모델에 없어 0 원이다 — 규칙 줄이 있어도 셈에 들지 않는다(지어내지 않는다)', () => {
    expect(KINDER_MARKER_EXISTS).toBe(false);
    expect(lessonBonus(lesson({ kindKey: 'class' }), rules).parts.some((p) => p.kind === 'kinder_hourly')).toBe(false);
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

describe('강사 히스토리 정산 종류별 근거 (N-93 · 강사 덱 29)', () => {
  const paid = (over: Partial<PayoutLesson>): PayoutLesson => ({
    serId: 1, onDate: '2026-09-15', date: '2026-09-15', startMin: 600, durMin: 60,
    kindKey: 'class', subKey: null, mode: 'offline', title: null,
    students: '김민준', studentCount: 1, repState: 'ok', canceled: false, submittedAt: '2026-09-15 12:00',
    pay: 45000, lateCut: 0, penaltyIfNow: null, bonus: 0, bonusParts: [], unitRate: 45000,
    settle: 'written', correctionOf: null, paidIn: null, frozen: false,
    ...over,
  });

  it('기본 시급과 그룹·진단·모의 가산을 서버가 각각 합계한다 — 겹친 모의 그룹도 총액과 맞다', () => {
    const out = payoutBreakdown([
      paid({ serId: 10, durMin: 30, pay: 22500 }),
      paid({
        serId: 11, kindKey: 'mock', durMin: 60, pay: 45000, bonus: 25000,
        bonusParts: [{ kind: 'per_session', amount: 15000 }, { kind: 'group_per_student', amount: 10000 }],
      }),
      paid({
        serId: 12, kindKey: 'diagx', durMin: 90, pay: 67500, bonus: 15000,
        bonusParts: [{ kind: 'per_session', amount: 15000 }],
      }),
    ]);
    expect(out.map((r) => [r.key, r.lessonCount, r.minutes, r.amount])).toEqual([
      ['general', 1, 30, 22500],
      ['kinder', 0, 0, 0],
      ['group', 1, 60, 10000],
      ['diag', 1, 90, 82500],
      ['mock', 1, 60, 60000],
      ['other', 0, 0, 0],
    ]);
    expect(out.reduce((sum, row) => sum + row.amount, 0)).toBe(175000);
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
