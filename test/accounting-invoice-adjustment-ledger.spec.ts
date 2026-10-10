/** @file-guide
 * 목적: 청구서별 환불예정액이 조정 행 개수에 따라 중복 합산되지 않는지 검증한다. (test)
 * 책임/재사용: 실제 InvoiceAdjustmentsService.ledger를 호출하며 합성 조회 결과만 제공한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/OPS-RISK-AUDIT-R118-2026-10-10.md
 */
import type { DataSource } from 'typeorm';
import { InvoiceAdjustmentsService } from '../src/modules/accounting/invoice-adjustments.service';

const adjustment = (id: number, invoiceId: number, invoiceAmount: number, paidAmount: number) => ({
  id, inv_id: invoiceId, student_id: invoiceId, year_month: '2026-10', effective_on: '2026-10-10',
  kind: 'refund', reason: '합계 회귀', amount: 10_000, state: 'approved', row_version: 2,
  original_amount: 100_000, invoice_amount: invoiceAmount, paid_amount: paidAmount,
  requested_by: 1, requested_by_name: '합성 관리자', requested_at: '2026-10-10T00:00:00Z',
  student_name: '합성 학생', student_tag: null,
});

async function ledger(rows: ReturnType<typeof adjustment>[]) {
  const query = jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  return new InvoiceAdjustmentsService({ query } as unknown as DataSource).ledger('2026-10', true, true);
}

describe('환불예정 합계의 청구서 단위', () => {
  it('한 청구서의 두 조정은 환불예정액을 한 번만 더하고 조정 금액은 각각 더한다', async () => {
    const result = await ledger([adjustment(1, 10, 80_000, 100_000), adjustment(2, 10, 80_000, 100_000)]);
    expect(result.refundDue).toBe(20_000);
    expect(result.approvedAmount).toBe(20_000);
    expect(result.items.map((item) => item.refundDue)).toEqual([20_000, 20_000]);
  });

  it('서로 다른 청구서의 같은 금액은 모두 합산한다', async () => {
    const result = await ledger([
      adjustment(1, 10, 80_000, 100_000), adjustment(2, 10, 80_000, 100_000),
      adjustment(3, 20, 80_000, 100_000), adjustment(4, 30, 100_000, 50_000),
    ]);
    expect(result.refundDue).toBe(40_000);
  });

  it('빈 원장과 미수금만 있는 원장은 환불예정 0원이다', async () => {
    expect((await ledger([])).refundDue).toBe(0);
    expect((await ledger([adjustment(1, 10, 100_000, 50_000)])).refundDue).toBe(0);
  });
});
