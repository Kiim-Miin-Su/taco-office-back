/** @file-guide
 * 목적: accounting.service.ts — AccountingService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Inv } from '../../entities';
import { todayKst } from '../../lib/kst';
import { won } from '../../lib/rules';
import { EXPENSE_CATEGORY_LABEL } from './accounting.dto';
import type {
  AccountingDto, ExpenseDto, ExpenseReviewDto, InvoiceDto, PaymentCreateDto, PaymentDto, PayoutDto,
} from './accounting.dto';

const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

/** 한 청구서를 조회하는 SQL — 목록과 입금 쓰기 응답이 **같은 모양**을 쓰도록 한 곳에 둔다 */
const INV_SELECT = `
  SELECT i.id, i.student_id, s.name AS student_name, s.grade, i.year_month, i.title,
         i.amount, i.paid_amount, i.state,
         to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
         to_char(i.due_on,'YYYY-MM-DD') AS due_on,
         to_char(i.paid_at,'YYYY-MM-DD') AS paid_at,
         COALESCE((SELECT json_agg(json_build_object(
            'subKey', l.sub_key, 'label', l.label, 'count', l.count,
            'unitPrice', l.unit_price, 'amount', l.amount) ORDER BY l.seq)
           FROM inv_line l WHERE l.inv_id = i.id), '[]'::json) AS lines
    FROM inv i JOIN stu s ON s.id = i.student_id`;

/** 입금을 받을 수 있는 상태인가 — §53 단계 순서(①작성 ②청구서 작성 ③학부모 안내 ④입금 완료 ⑤입금 기록) */
const BILLABLE = new Set(['sent', 'unpaid', 'partial', 'paid']);

/** 나간 돈 한 줄 — 목록과 심사 응답이 같은 모양을 쓰도록 한 곳에 둔다 (§56) */
const EXPENSE_SELECT = `
  SELECT e.id, to_char(e.spend_on,'YYYY-MM-DD') AS spend_on, e.category, e.merchant, e.purpose,
         e.requested_amount, e.amount, e.reason, (e.receipt_url IS NOT NULL) AS has_receipt,
         e.requester_id, rq.name AS requester_name, e.state, rv.name AS reviewer_name,
         to_char(e.reviewed_at,'YYYY-MM-DD') AS reviewed_at
    FROM expense e
    LEFT JOIN staff rq ON rq.id = e.requester_id
    LEFT JOIN staff rv ON rv.id = e.reviewer_id`;

@Injectable()
export class AccountingService {
  constructor(@InjectRepository(Inv) private readonly inv: Repository<Inv>) {}

  /**
   * @param canSeeAmounts 대표만 금액을 본다 (D-R39). **가리는 일을 화면에 맡기지 않는다** —
   *   서버가 아예 null 로 내려보낸다. 화면에서만 감추면 네트워크 탭에 그대로 보인다.
   */
  /** 목록과 쓰기 응답이 같은 모양을 쓰도록 한 행의 변환도 한 곳에 둔다 */
  private invoiceRow(r: Record<string, unknown>, canSeeAmounts: boolean, today: string): InvoiceDto {
    const money = (v: unknown): number | null => (canSeeAmounts && v != null ? Number(v) : null);
    const due = r.due_on as string | null;
    const unpaid = r.state === 'unpaid' || r.state === 'partial' || r.state === 'sent';
    return {
      id: Number(r.id), studentId: Number(r.student_id), studentName: String(r.student_name),
      grade: (r.grade as string | null) ?? null,
      yearMonth: String(r.year_month), title: String(r.title),
      amount: money(r.amount), paidAmount: money(r.paid_amount), state: String(r.state),
      // 잔액도 금액이다 — 권한이 없으면 내려보내지 않는다 (빼기로 복원되면 가린 뜻이 없다)
      remaining: canSeeAmounts ? Number(r.amount) - Number(r.paid_amount) : null,
      issuedOn: (r.issued_on as string | null) ?? null,
      dueOn: due, paidAt: (r.paid_at as string | null) ?? null,
      overdueDays: unpaid && due && due < today ? daysBetween(due, today) : 0,
      lines: canSeeAmounts
        ? (r.lines as InvoiceDto['lines'])
        : (r.lines as InvoiceDto['lines']).map((l) => ({ ...l, unitPrice: 0, amount: 0 })),
    };
  }

  async all(canSeeAmounts: boolean): Promise<AccountingDto> {
    // PAY의 NULL은 아직 확인하지 않은 값이다. 권한이 있어도 0원으로 채우지 않는다.
    const money = (v: unknown): number | null => (canSeeAmounts && v != null ? Number(v) : null);
    const today = todayKst();

    const invRows = (await this.inv.query(
      `${INV_SELECT} ORDER BY i.year_month DESC, i.id`,
    )) as Array<Record<string, unknown>>;

    const invoices: InvoiceDto[] = invRows.map((r) => this.invoiceRow(r, canSeeAmounts, today));

    const payRows = (await this.inv.query(
      `SELECT p.id, to_char(p.paid_on,'YYYY-MM-DD') AS paid_on, p.student_id, s.name AS student_name,
              p.amount, p.method, p.reason, p.inv_id
         FROM pay p LEFT JOIN stu s ON s.id = p.student_id
        ORDER BY p.paid_on DESC, p.id DESC`,
    )) as Array<Record<string, unknown>>;
    const payments: PaymentDto[] = payRows.map((r) => ({
      id: Number(r.id), paidOn: r.paid_on == null ? null : String(r.paid_on),
      studentId: r.student_id ? Number(r.student_id) : null,
      studentName: (r.student_name as string | null) ?? null,
      amount: money(r.amount), method: (r.method as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
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

    const expRows = (await this.inv.query(
      `${EXPENSE_SELECT} ORDER BY e.state = 'pending' DESC, e.spend_on DESC, e.id DESC`,
    )) as Array<Record<string, unknown>>;
    const expenses: ExpenseDto[] = expRows.map((r) => this.expenseRow(r, canSeeAmounts));

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
      invoices, payments, payouts, expenses,
    };
  }

  /** 나간 돈 한 행 — 신청 금액도 금액이다. 권한이 없으면 placeholder 조차 내려보내지 않는다. */
  private expenseRow(r: Record<string, unknown>, canSeeAmounts: boolean): ExpenseDto {
    const money = (v: unknown): number | null => (canSeeAmounts && v != null ? Number(v) : null);
    const category = String(r.category);
    return {
      id: Number(r.id), spendOn: String(r.spend_on),
      category, categoryLabel: EXPENSE_CATEGORY_LABEL[category] ?? category,
      merchant: (r.merchant as string | null) ?? null,
      purpose: (r.purpose as string | null) ?? null,
      requestedAmount: money(r.requested_amount), amount: money(r.amount),
      reason: (r.reason as string | null) ?? null,
      hasReceipt: r.has_receipt === true,
      requesterId: r.requester_id == null ? null : Number(r.requester_id),
      requesterName: (r.requester_name as string | null) ?? null,
      state: String(r.state),
      reviewerName: (r.reviewer_name as string | null) ?? null,
      reviewedAt: (r.reviewed_at as string | null) ?? null,
    };
  }

  /**
   * 입금 한 줄 등록 — **분납은 줄을 늘린다** (A-D2). 누계·전이·초과 판정은 여기 한 곳뿐이다.
   *
   * 세 층으로 막는다 (원칙 26 · D-R43) — ① 트랜잭션 경계 ② `SELECT … FOR UPDATE` 로 같은 청구서 경합
   * ③ 마지막은 DB CHECK `inv_paid_le_amount`. 애플리케이션 검사만으로 끝내지 않는다.
   * `paid_amount` 는 화면이 더한 값이 아니라 **그 순간 PAY 줄의 합**을 다시 세어 넣는다.
   */
  async addPayment(userId: number, dto: PaymentCreateDto, canSeeAmounts: boolean): Promise<InvoiceDto> {
    const today = todayKst();
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [inv] = (await m.query(
        `SELECT id, amount, state FROM inv WHERE id = $1 FOR UPDATE`, [dto.invId],
      )) as Array<{ id: string; amount: number; state: string }>;
      if (!inv) throw new NotFoundException('청구서를 찾을 수 없습니다');
      if (!BILLABLE.has(inv.state)) {
        throw new ConflictException({
          code: 'INV_NOT_BILLABLE',
          message: inv.state === 'void'
            ? '취소된 청구서에는 입금을 붙일 수 없습니다'
            : '아직 발행하지 않은 청구서입니다 — 청구서 작성·학부모 안내 뒤에 입금을 기록합니다',
        });
      }

      const [sums] = (await m.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS paid FROM pay WHERE inv_id = $1`, [dto.invId],
      )) as Array<{ paid: number }>;
      const before = Number(sums.paid);
      const billed = Number(inv.amount);
      const next = before + dto.amount;
      if (next > billed) {
        throw new ConflictException({
          code: 'OVERPAY',
          message: `남은 금액은 ${won(billed - before)}입니다 — 그보다 많이 적을 수 없습니다. 초과 입금은 환불·조정으로 처리하세요`,
        });
      }

      await m.query(
        `INSERT INTO pay (inv_id, student_id, amount, paid_on, method, reason, entered_by, entered_at,
                          confirmed_by, confirmed_at)
         SELECT $1, i.student_id, $2, $3::date, $4, $5, $6, now(), $6, now() FROM inv i WHERE i.id = $1`,
        [dto.invId, dto.amount, dto.paidOn, dto.method ?? null, dto.reason?.trim() || null, userId],
      );
      await m.query(
        `UPDATE inv SET paid_amount = $2,
                        state = CASE WHEN $2 >= amount THEN 'paid'::inv_state_t ELSE 'partial'::inv_state_t END,
                        paid_at = CASE WHEN $2 >= amount THEN now() ELSE NULL END
          WHERE id = $1`,
        [dto.invId, next],
      );
      const [row] = (await m.query(`${INV_SELECT} WHERE i.id = $1`, [dto.invId])) as Array<Record<string, unknown>>;
      return this.invoiceRow(row, canSeeAmounts, today);
    });
  }

  /**
   * 잘못 적은 입금 줄을 지운다 — **부분 납부(partial) 인 동안만**.
   *
   * 완납으로 굳은 청구서는 되돌리지 않는다 (erd INV Note: 「상태 전이는 unpaid → partial → paid 와 → void 뿐이며
   * 되돌리기가 없다」). 정정·환불은 별도 승인 경로다. 마지막 줄을 지우면 발행 사실(sent_at)이 있는 청구서는
   * 「전달」로, 없으면 「미납」으로 돌아간다 — 발행 이력을 지우지 않는다.
   */
  async removePayment(payId: number): Promise<{ ok: true }> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [pay] = (await m.query(`SELECT id, inv_id FROM pay WHERE id = $1`, [payId])) as Array<{
        id: string; inv_id: string | null;
      }>;
      if (!pay) throw new NotFoundException('입금 기록을 찾을 수 없습니다');
      if (pay.inv_id == null) {
        // 청구서 없는 직접 입력 건 (A-D1) — 누계를 되돌릴 청구서가 없다
        await m.query(`DELETE FROM pay WHERE id = $1`, [payId]);
        return { ok: true as const };
      }
      const invId = Number(pay.inv_id);
      const [inv] = (await m.query(
        `SELECT id, state, (sent_at IS NOT NULL) AS was_sent FROM inv WHERE id = $1 FOR UPDATE`, [invId],
      )) as Array<{ id: string; state: string; was_sent: boolean }>;
      if (inv && inv.state !== 'partial') {
        throw new ConflictException({
          code: 'INV_PAID_LOCKED',
          message: inv.state === 'paid'
            ? '완납된 청구서의 입금 줄은 지울 수 없습니다 — 정정·환불은 별도 승인으로 처리하세요'
            : '이 청구서는 입금 줄을 고칠 수 있는 상태가 아닙니다',
        });
      }
      await m.query(`DELETE FROM pay WHERE id = $1`, [payId]);
      const [sums] = (await m.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS paid FROM pay WHERE inv_id = $1`, [invId],
      )) as Array<{ paid: number }>;
      const left = Number(sums.paid);
      await m.query(
        `UPDATE inv SET paid_amount = $2,
                        state = CASE WHEN $2 > 0 THEN 'partial'::inv_state_t
                                     WHEN $3 THEN 'sent'::inv_state_t
                                     ELSE 'unpaid'::inv_state_t END,
                        paid_at = NULL
          WHERE id = $1`,
        [invId, left, inv?.was_sent === true],
      );
      return { ok: true as const };
    });
  }

  /**
   * 법인카드 심사 — **증액은 없다** (A-D3 채택: 증액 금지 · 재신청으로).
   *
   * 다섯 규칙이 전부 여기 한 곳에 있다 (ACCOUNTING §4.3).
   *   A-1 승인 금액의 기본값은 비어 있다 — 신청 금액은 placeholder 로만 (화면)
   *   A-2 승인 금액 > 신청 금액 은 차단 (A-D3)          → CARD_AMOUNT_EXCEEDS_REQUEST 422
   *   A-3 승인 금액 ≠ 신청 금액 이면 사유 필수            → AMOUNT_REASON_REQUIRED 400
   *   A-4 영수증 없이 승인 불가                          → CARD_RECEIPT_REQUIRED 422
   *   A-5 본인이 올린 신청을 본인이 승인할 수 없다        → SELF_APPROVAL_FORBIDDEN 403
   * 마지막 방어선은 마이그레이션 1758500000000 의 CHECK 넷이다 — 애플리케이션 검사로 끝내지 않는다.
   */
  async reviewExpense(userId: number, id: number, dto: ExpenseReviewDto, canSeeAmounts: boolean): Promise<ExpenseDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [row] = (await m.query(
        `SELECT id, requested_amount, requester_id, state, (receipt_url IS NOT NULL) AS has_receipt
           FROM expense WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; requested_amount: number | null; requester_id: string | null; state: string; has_receipt: boolean }>;
      if (!row) throw new NotFoundException('지출 건을 찾을 수 없습니다');
      if (row.state !== 'pending') {
        throw new ConflictException({
          code: 'EXPENSE_ALREADY_REVIEWED',
          message: `이미 ${row.state === 'approved' ? '승인' : '반려'}된 건입니다 — 다시 심사하지 않습니다`,
        });
      }
      if (row.requester_id != null && Number(row.requester_id) === userId) {
        throw new ForbiddenException({
          code: 'SELF_APPROVAL_FORBIDDEN',
          message: '본인이 올린 신청은 본인이 심사할 수 없습니다 — 금액을 제안하는 사람과 확정하는 사람은 다릅니다',
        });
      }

      const reason = dto.reason?.trim() || null;
      if (dto.decision === 'reject') {
        if (!reason) throw new BadRequestException({ code: 'AMOUNT_REASON_REQUIRED', message: '반려 사유를 적어 주세요' });
        await m.query(
          `UPDATE expense SET state = 'rejected', reason = $2, reviewer_id = $3, reviewed_at = now() WHERE id = $1`,
          [id, reason, userId],
        );
      } else {
        if (!row.has_receipt) {
          throw new UnprocessableEntityException({
            code: 'CARD_RECEIPT_REQUIRED', message: '영수증이 없으면 승인할 수 없습니다',
          });
        }
        const requested = row.requested_amount == null ? null : Number(row.requested_amount);
        const amount = dto.amount;
        if (amount === undefined) {
          throw new BadRequestException({ code: 'AMOUNT_REASON_REQUIRED', message: '확정 금액을 넣어 주세요 — 신청 금액은 안내일 뿐입니다' });
        }
        if (requested !== null && amount > requested) {
          throw new UnprocessableEntityException({
            code: 'CARD_AMOUNT_EXCEEDS_REQUEST',
            message: `신청 금액 ${won(requested)}보다 크게 승인할 수 없습니다 — 증액은 재신청으로 처리하세요 (A-D3)`,
          });
        }
        if (requested !== null && amount !== requested && !reason) {
          throw new BadRequestException({
            code: 'AMOUNT_REASON_REQUIRED', message: '신청 금액과 다르게 승인하려면 사유가 필요합니다',
          });
        }
        await m.query(
          `UPDATE expense SET state = 'approved', amount = $2, reason = COALESCE($3, reason),
                              reviewer_id = $4, reviewed_at = now() WHERE id = $1`,
          [id, amount, reason, userId],
        );
      }
      const [out] = (await m.query(`${EXPENSE_SELECT} WHERE e.id = $1`, [id])) as Array<Record<string, unknown>>;
      return this.expenseRow(out, canSeeAmounts);
    });
  }
}
