import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Inv } from '../../entities';
import type { AccountingDto, InvoiceDto, PaymentDto, PayoutDto } from './accounting.dto';

const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

@Injectable()
export class AccountingService {
  constructor(@InjectRepository(Inv) private readonly inv: Repository<Inv>) {}

  /**
   * @param canSeeAmounts 대표만 금액을 본다 (D-R39). **가리는 일을 화면에 맡기지 않는다** —
   *   서버가 아예 null 로 내려보낸다. 화면에서만 감추면 네트워크 탭에 그대로 보인다.
   */
  async all(canSeeAmounts: boolean): Promise<AccountingDto> {
    const money = (v: unknown): number | null => (canSeeAmounts ? Number(v ?? 0) : null);
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const invRows = (await this.inv.query(
      `SELECT i.id, i.student_id, s.name AS student_name, s.grade, i.year_month, i.title,
              i.amount, i.paid_amount, i.state,
              to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
              to_char(i.due_on,'YYYY-MM-DD') AS due_on,
              to_char(i.paid_at,'YYYY-MM-DD') AS paid_at,
              COALESCE((SELECT json_agg(json_build_object(
                 'subKey', l.sub_key, 'label', l.label, 'count', l.count,
                 'unitPrice', l.unit_price, 'amount', l.amount) ORDER BY l.seq)
                FROM inv_line l WHERE l.inv_id = i.id), '[]'::json) AS lines
         FROM inv i JOIN stu s ON s.id = i.student_id
        ORDER BY i.year_month DESC, i.id`,
    )) as Array<Record<string, unknown>>;

    const invoices: InvoiceDto[] = invRows.map((r) => {
      const due = r.due_on as string | null;
      const unpaid = r.state === 'unpaid' || r.state === 'partial' || r.state === 'sent';
      return {
        id: Number(r.id), studentId: Number(r.student_id), studentName: String(r.student_name),
        grade: (r.grade as string | null) ?? null,
        yearMonth: String(r.year_month), title: String(r.title),
        amount: money(r.amount), paidAmount: money(r.paid_amount), state: String(r.state),
        issuedOn: (r.issued_on as string | null) ?? null,
        dueOn: due, paidAt: (r.paid_at as string | null) ?? null,
        overdueDays: unpaid && due && due < today ? daysBetween(due, today) : 0,
        lines: canSeeAmounts
          ? (r.lines as InvoiceDto['lines'])
          : (r.lines as InvoiceDto['lines']).map((l) => ({ ...l, unitPrice: 0, amount: 0 })),
      };
    });

    const payRows = (await this.inv.query(
      `SELECT p.id, to_char(p.paid_on,'YYYY-MM-DD') AS paid_on, p.student_id, s.name AS student_name,
              p.amount, p.method, p.inv_id
         FROM pay p LEFT JOIN stu s ON s.id = p.student_id
        ORDER BY p.paid_on DESC, p.id DESC`,
    )) as Array<Record<string, unknown>>;
    const payments: PaymentDto[] = payRows.map((r) => ({
      id: Number(r.id), paidOn: String(r.paid_on),
      studentId: r.student_id ? Number(r.student_id) : null,
      studentName: (r.student_name as string | null) ?? null,
      amount: money(r.amount), method: (r.method as string | null) ?? null,
      invId: r.inv_id ? Number(r.inv_id) : null,
    }));

    const poRows = (await this.inv.query(
      `SELECT po.id, po.staff_id, t.name AS staff_name, po.year_month, po.hours,
              po.gross, po.late_rep_cut, po.income_tax, po.local_tax, po.net, po.state
         FROM payout po JOIN staff t ON t.id = po.staff_id
        ORDER BY po.year_month DESC, po.net DESC`,
    )) as Array<Record<string, unknown>>;
    const payouts: PayoutDto[] = poRows.map((r) => ({
      id: Number(r.id), staffId: Number(r.staff_id), staffName: String(r.staff_name),
      yearMonth: String(r.year_month), hours: String(r.hours),
      gross: money(r.gross), lateRepCut: money(r.late_rep_cut),
      incomeTax: money(r.income_tax), localTax: money(r.local_tax), net: money(r.net),
      state: String(r.state),
    }));

    const billed = invoices.reduce((a, i) => a + (i.amount ?? 0), 0);
    const collected = invoices.reduce((a, i) => a + (i.paidAmount ?? 0), 0);
    return {
      summary: {
        invoiceCount: invoices.length,
        billed: canSeeAmounts ? billed : null,
        collected: canSeeAmounts ? collected : null,
        outstanding: canSeeAmounts ? billed - collected : null,
        overdueCount: invoices.filter((i) => i.overdueDays > 0).length,
        canSeeAmounts,
      },
      invoices, payments, payouts,
    };
  }
}
