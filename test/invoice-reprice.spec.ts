/** @file-guide
 * 목적: invoice-reprice.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 재가격 판정 — C64 (대표 결정 2026-09-13 · N-38 「미납 건만 다시 낸다」).
 *
 * 교정 금액은 **대개 내려간다.** 그래서 이미 받은 돈이 새 금액보다 많으면 완납이던 건이
 * **과납**으로 바뀐다. 그 갈래를 도구가 자동으로 처리하면 이미 오간 돈을 되돌리는 일이 되므로,
 * 여기서 증명하는 것은 **손대지 않는 자리가 정확히 어디인가**다.
 */
import { repriceVerdict, linesTotal } from '../src/modules/accounting/invoice-lines';
import { INV_TYPES, INV_TYPE_LABEL, INV_TYPE_SUB, INV_TYPES_OTHER } from '../src/modules/accounting/accounting.dto';

describe('재가격 판정 (C64)', () => {
  it('금액이 같으면 손댈 것이 없다', () => {
    expect(repriceVerdict(100_000, 100_000, 0)).toBe('same');
    expect(repriceVerdict(100_000, 100_000, 100_000)).toBe('same');
  });

  it('받은 돈이 0 이면 그냥 다시 낸다 — 오간 돈이 없다', () => {
    expect(repriceVerdict(220_000, 114_000, 0)).toBe('reissue');
    expect(repriceVerdict(100_000, 180_000, 0)).toBe('reissue');
  });

  it('일부만 받았고 그 돈이 새 금액 안이면 입금 줄을 옮겨 다시 낸다', () => {
    expect(repriceVerdict(380_000, 604_000, 380_000)).toBe('reissue_move_pay');
    expect(repriceVerdict(200_000, 150_000, 150_000)).toBe('reissue_move_pay');
  });

  it('받은 돈이 새 금액보다 많으면 **손대지 않는다** — 과납은 사람이 정한다', () => {
    expect(repriceVerdict(560_000, 70_000, 560_000)).toBe('overpaid');
    expect(repriceVerdict(520_000, 57_000, 320_000)).toBe('overpaid');
    // 딱 한 원만 넘어도 과납이다 — 경계에서 자동 처리로 새지 않는다
    expect(repriceVerdict(100_000, 50_000, 50_001)).toBe('overpaid');
    expect(repriceVerdict(100_000, 50_000, 50_000)).toBe('reissue_move_pay');
  });

  it('금액이 오르는 쪽도 같은 판정을 쓴다 — 내려가는 경우만 특별 대접하지 않는다', () => {
    expect(repriceVerdict(360_000, 140_000, 0)).toBe('reissue');
    expect(repriceVerdict(720_000, 885_000, 0)).toBe('reissue');
    expect(repriceVerdict(720_000, 885_000, 720_000)).toBe('reissue_move_pay');
  });

  it('총액은 줄의 합이다 — 두 곳에서 더하지 않는다', () => {
    expect(linesTotal([
      { sub_key: 'a', label: 'A', n: 2, unit_price: 45_000 },
      { sub_key: 'b', label: 'B', n: 1, unit_price: 24_000 },
    ])).toBe(114_000);
  });
});

describe('청구 종류 넷 (C64 · 대표 결정 N-37)', () => {
  it('§57 컷의 세 줄 + 수업료 = 넷이다', () => {
    expect([...INV_TYPES]).toEqual(['tuition', 'consulting', 'diag_intake', 'exam_fee']);
  });

  it('종류마다 이름과 부제가 있다 — 화면이 코드값을 찍지 않는다 (D-R18)', () => {
    const missing = INV_TYPES.filter((t) => !INV_TYPE_LABEL[t] || !INV_TYPE_SUB[t]);
    expect(missing).toEqual([]);
  });

  it('「그 밖의 수입」은 수업료가 아닌 셋이다 — 화면이 다시 거르지 않는다', () => {
    expect([...INV_TYPES_OTHER]).toEqual(['consulting', 'diag_intake', 'exam_fee']);
    expect(INV_TYPES_OTHER).not.toContain('tuition');
  });

  it('이름은 컷에서 읽은 그대로다', () => {
    expect(INV_TYPE_LABEL.diag_intake).toBe('진단고사 + 상담 비용');
    expect(INV_TYPE_SUB.diag_intake).toBe('진단고사 · 입학 상담');
    expect(INV_TYPE_LABEL.exam_fee).toBe('MAP + CAT 응시료');
    expect(INV_TYPE_SUB.exam_fee).toBe('MAP · CAT 응시료');
  });
});
