/** @file-guide
 * 목적: accounting.service.ts — AccountingService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Inv } from '../../entities';
import { areaCountSql } from '../../lib/exec-areas';
import { todayKst } from '../../lib/kst';
import { INV_BILLABLE, INV_DELIVERABLE, INV_OPEN, payoutConfirmed, payoutConfirmedSql, won } from '../../lib/rules';
import { kstAt, kstMonthOf, serStuOn, sqlWordList, stuPausedOn } from '../../lib/sql';
import { assertMonthOpen } from '../../lib/month-close';
import { TEACHER_OF_OCC, payoutSheet } from '../../lib/payout-sheet';
import { nowMinKst } from '../../lib/kst';
import {
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, EXPENSE_SETTLED,
  INV_BOARD_COLUMNS, INV_STATE_LABEL, INV_TYPES_OTHER, INV_TYPE_LABEL, INV_TYPE_ROW, INV_TYPE_SUB,
  PAY_CATEGORIES, PAY_CATEGORY_LABEL, invBoardColumn, payCategory, type IncomeSpan,
} from './accounting.dto';
import { invoiceLines, linesTotal, type LineSlice } from './invoice-lines';
import type {
  AccountingDto, ExpenseDto, ExpenseReviewDto, ExpenseTotalDto, InvoiceDto, InvoiceIssueDto,
  CarryRowDto, InvBoardDto, OtherIncomeDto,
  PaymentCreateDto, PaymentDto, PayoutDto,
  TuitionCarryDto,
  TuitionDto, TuitionRowDto,
  MonthCloseDto, MonthCloseWriteDto, MonthReopenWriteDto,
  InvoiceBatchDto, InvoiceBatchResultDto, InvoiceBatchSkipDto, InvoiceVoidDto,
  PayoutSheetDto, PayoutSheetRowDto, PayoutConfirmDto,
  RateBookDto, RateRowDto, RateWriteDto, StudentRateRowDto, StudentRateWriteDto, ExpenseCreateDto,
} from './accounting.dto';
import { fileUrlOf } from '../files/files.service';


/** 날짜 눈금의 시작일 — 주는 **월요일**에 건다 (§73 결재함과 같은 셈 · C67) */
function spanStart(iso: string, span: IncomeSpan): string {
  if (span === 'month') return `${iso.slice(0, 7)}-01`;
  if (span === 'day') return iso;
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** 묶음의 이름 — 낱말도 서버가 만든다 (D-R18) */
function spanLabel(start: string, span: IncomeSpan): string {
  const [y, m, d] = start.split('-').map(Number);
  if (span === 'month') return `${y}년 ${m}월`;
  if (span === 'day') return `${m}월 ${d}일`;
  const end = new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
  return `${start.slice(5)} ~ ${end.slice(5)}`;
}

/**
 * 발행일로 묶는다 — 줄의 「건수 · 금액」이 청구서를 세는 값이기 때문이다.
 * **발행일이 없는 건은 버리지 않는다** — 「날짜 없음」 묶음에 모아 맨 뒤에 둔다.
 */
function groupBySpan<T extends { issued_on: string | null }>(
  rows: T[], span: IncomeSpan,
): Array<{ key: string; label: string; rows: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.issued_on ? spanStart(r.issued_on, span) : 'none';
    const at = buckets.get(key);
    if (at) at.push(r); else buckets.set(key, [r]);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] === 'none' ? 1 : b[0] === 'none' ? -1 : b[0].localeCompare(a[0])))
    .map(([key, rs]) => ({ key, label: key === 'none' ? '날짜 없음' : spanLabel(key, span), rows: rs }));
}

/**
 * 카드 오른쪽의 한 마디 — 「D-21」 · 「1일 지남」 · 「오늘」.
 *
 * **낱말도 서버가 만든다** (D-R18). 화면이 날짜를 빼기 시작하면 「연체」 배지와 이 글자가 갈린다.
 */
function invWhenLabel(due: string | null, today: string, overdueDays: number): string {
  if (!due) return '기한 없음';
  if (overdueDays > 0) return `${overdueDays}일 지남`;
  if (due === today) return '오늘';
  /*
   * **지났는데 연체가 아닌 것** — 완납했거나 아직 청구 전인 건이다. 여기서 `D-` 를 그대로 쓰면
   * **「D--23」** 이 찍힌다(실제로 찍혔다). 남은 날이 없으므로 날 수 대신 기한을 적는다.
   */
  if (due < today) return `기한 ${due.slice(5)}`;
  return `D-${daysBetween(today, due)}`;
}

const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000);

/** 한 청구서를 조회하는 SQL — 목록과 입금 쓰기 응답이 **같은 모양**을 쓰도록 한 곳에 둔다 */
const INV_SELECT = `
  SELECT i.id, i.student_id, s.name AS student_name, s.grade, i.year_month, i.title,
         i.amount, i.paid_amount, i.state,
         to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
         to_char(i.due_on,'YYYY-MM-DD') AS due_on,
         to_char(i.paid_at,'YYYY-MM-DD') AS paid_at,
         i.sent_at, i.detail->'void'->>'reason' AS void_reason,
         COALESCE((SELECT json_agg(json_build_object(
            'subKey', l.sub_key, 'label', l.label, 'count', l.count,
            'unitPrice', l.unit_price, 'amount', l.amount) ORDER BY l.seq)
           FROM inv_line l WHERE l.inv_id = i.id), '[]'::json) AS lines
    FROM inv i JOIN stu s ON s.id = i.student_id`;

/**
 * 입금을 받을 수 있는 상태인가 — §53 단계 순서(①작성 ②청구서 작성 ③학부모 안내 ④입금 완료 ⑤입금 기록).
 * 낱말은 `lib/rules` 한 곳에서 온다 — 머리의 「보낸 청구서」와 같은 집합이어야 한다 (D-R18).
 */
const BILLABLE = new Set<string>(INV_BILLABLE);

/**
 * 회계 머리 여섯 칸 중 **돈 다섯 칸의 뿌리** — §52·§56 원문 (C43).
 *
 * 「못 받은 돈」을 화면이 빼서 만들면 두 벌이 된다. 서버가 한 번에 낸다.
 * `$1` = 기준일(오늘, KST) — 「기한 지남」만 이 값을 쓴다.
 */
const MONEY_SUMMARY_SQL = `
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE state IN (${sqlWordList(INV_BILLABLE)})), 0)::bigint AS sent,
    COALESCE(SUM(paid_amount) FILTER (WHERE state IN (${sqlWordList(INV_BILLABLE)})), 0)::bigint AS collected,
    COALESCE(SUM(amount - paid_amount) FILTER (
      WHERE state IN (${sqlWordList(INV_OPEN)}) AND due_on IS NOT NULL AND due_on < $1::date), 0)::bigint AS overdue
    FROM inv`;

/**
 * 나간 돈 — 「남은 돈 = 받은 돈 − 나간 돈」의 뒷항.
 *
 * 승인된 지출(§56 부대비용·법인카드)과 **확정된** 강사료 정산이다. 초안 정산·미심사 지출은
 * 아직 나간 돈이 아니다. 강사료는 §56 원문이 「8월에 드릴 돈」이라 부르는 **실지급(net)** 을 쓴다 —
 * 원본 표본이 그 자리에 5,096,750 − 95,000 − 165,058 = 4,836,692 를 적어 두었다.
 *
 * 지출은 낱말로 고른다 — `expense.state` 는 CHECK `expense_state_words` 가 지키는 세 낱말뿐이다.
 * **정산은 낱말로 고르지 않는다** — 확정 판정은 `lib/rules` 한 곳에 있다 (N-27 · 대표 결정).
 */
const MONEY_OUT_SQL = `
  SELECT (
    COALESCE((SELECT SUM(amount) FROM expense WHERE state = '${EXPENSE_SETTLED}'), 0)
    + COALESCE((SELECT SUM(net) FROM payout WHERE ${payoutConfirmedSql()}), 0)
  )::bigint AS out`;

/** §56 분류별 확정 지출 — 머리의 「남은 돈」과 **같은 집합**을 본다. 화면이 더하지 않는다 (C43-b) */
const EXPENSE_TOTAL_SQL = `
  SELECT category, SUM(amount)::bigint AS sum
    FROM expense WHERE state = '${EXPENSE_SETTLED}' AND amount IS NOT NULL
   GROUP BY category ORDER BY SUM(amount) DESC`;

/** 「손봐야 할 것」 — 대표 보고 §69 회계 배지와 **같은 판정**이다. 두 곳에서 세지 않는다 */
const MONEY_TODO_SQL = areaCountSql('money');

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
  private invoiceRow(r: Record<string, unknown>, canSeeAmounts: boolean, today: string, canVoidInvoice = false): InvoiceDto {
    const money = (v: unknown): number | null => (canSeeAmounts && v != null ? Number(v) : null);
    const due = r.due_on as string | null;
    const unpaid = r.state === 'unpaid' || r.state === 'partial' || r.state === 'sent';
    const state = String(r.state);
    return {
      // C94-a — 단추가 서는지는 여기서 정한다 (D-R39). 전달은 초안·미전달만, 취소는 대표 · 취소 전 · 입금 0
      sentAt: r.sent_at ? new Date(r.sent_at as string).toISOString() : null,
      canDeliver: (INV_DELIVERABLE as readonly string[]).includes(state),
      canVoid: canVoidInvoice && state !== 'void' && Number(r.paid_amount) === 0,
      voidReason: (r.void_reason as string | null) ?? null,
      id: Number(r.id), studentId: Number(r.student_id), studentName: String(r.student_name),
      grade: (r.grade as string | null) ?? null,
      yearMonth: String(r.year_month), title: String(r.title),
      amount: money(r.amount), paidAmount: money(r.paid_amount), state: String(r.state),
      // 낱말은 서버가 만든다 — 화면이 코드값을 찍거나 제 코드표를 갖지 않는다 (D-R18)
      stateLabel: INV_STATE_LABEL[String(r.state)] ?? String(r.state),
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

  async all(canSeeAmounts: boolean, canVoidInvoice = false): Promise<AccountingDto> {
    // PAY의 NULL은 아직 확인하지 않은 값이다. 권한이 있어도 0원으로 채우지 않는다.
    const money = (v: unknown): number | null => (canSeeAmounts && v != null ? Number(v) : null);
    const today = todayKst();

    const invRows = (await this.inv.query(
      `${INV_SELECT} ORDER BY i.year_month DESC, i.id`,
    )) as Array<Record<string, unknown>>;

    const invoices: InvoiceDto[] = invRows.map((r) => this.invoiceRow(r, canSeeAmounts, today, canVoidInvoice));

    /*
     * §55 의 **분류**는 저장된 칸이 아니라 **읽어서 만드는 값**이다 (대표 결정 N-37 ③ —
     * 「Entity, DTO 의 정합성과 단일 진실원 해결」). 그래서 여기서 청구서와 그 줄의 종류를 같이 읽는다.
     * `is_gpa` — 그 청구서의 줄이 **`kind = 'gpa'` 수업**에서 나왔는가. 수업료 중 GPA 관리비를 가른다.
     *
     * **과목이 어느 종류에 속하는지는 `rate` 가 안다** — 단가표가 (종류, 과목) 짝으로 서 있기 때문이다.
     * `sub` 자체에는 종류 칸이 없고, `inv_line` 도 **어느 종류에서 나온 줄인지 기억하지 않는다**.
     * 그래서 지금은 단가표를 거쳐 읽는다. 한 과목이 두 종류에 걸리면 이 읽기가 흔들리므로
     * **회귀가 그런 과목이 없는지 센다** — 생기는 날 빨개진다.
     * 더 단단한 길은 `inv_line` 이 제 종류를 들고 오는 것인데, **지금 있는 줄은 되짚어 채울 수 없다**
     * (N-25 — 추정 이관 금지). N-37 ③ 에 적어 두었다.
     */
    const payRows = (await this.inv.query(
      `SELECT p.id, to_char(p.paid_on,'YYYY-MM-DD') AS paid_on, p.student_id, s.name AS student_name,
              p.amount, p.method, p.reason, p.inv_id,
              i.inv_type,
              EXISTS (
                SELECT 1 FROM inv_line l JOIN rate r ON r.sub_key = l.sub_key
                 WHERE l.inv_id = i.id AND r.kind_key = 'gpa'
              ) AS is_gpa
         FROM pay p
         LEFT JOIN stu s ON s.id = p.student_id
         LEFT JOIN inv i ON i.id = p.inv_id
        ORDER BY p.paid_on DESC, p.id DESC`,
    )) as Array<Record<string, unknown>>;
    const payments: PaymentDto[] = payRows.map((r) => {
      // 판정은 `payCategory()` 한 함수뿐이다 — 화면도 칩도 같은 답을 쓴다 (D-R39)
      const category = payCategory((r.inv_type as string | null) ?? null, r.is_gpa === true);
      return {
        id: Number(r.id), paidOn: r.paid_on == null ? null : String(r.paid_on),
        studentId: r.student_id ? Number(r.student_id) : null,
        studentName: (r.student_name as string | null) ?? null,
        amount: money(r.amount), method: (r.method as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        invId: r.inv_id ? Number(r.inv_id) : null,
        category, categoryLabel: PAY_CATEGORY_LABEL[category] ?? category,
      };
    });

    /*
     * §55 의 분류 칩 — **건수가 0이어도 선다.** 분류는 어휘이지 데이터가 아니다
     * (§57 줄 셋 · §52 칸 넷과 같은 규약). 세는 것도 서버다 (D-R37).
     */
    const payCategories = PAY_CATEGORIES.map((c) => {
      const mine = payments.filter((p) => p.category === c.key);
      return {
        key: c.key, label: c.label, count: mine.length,
        amount: canSeeAmounts ? mine.reduce((n, p) => n + (p.amount ?? 0), 0) : null,
      };
    });

    const poRows = (await this.inv.query(
      `SELECT po.id, po.staff_id, t.name AS staff_name, po.year_month, po.hours,
              po.gross, po.late_rep_cut, po.income_tax, po.local_tax, po.net, po.confirmed_by
         FROM payout po JOIN staff t ON t.id = po.staff_id
        ORDER BY po.year_month DESC, po.net DESC`,
    )) as Array<Record<string, unknown>>;
    const payouts: PayoutDto[] = poRows.map((r) => ({
      id: Number(r.id), staffId: Number(r.staff_id), staffName: String(r.staff_name),
      yearMonth: String(r.year_month), hours: String(r.hours),
      gross: money(r.gross), lateRepCut: money(r.late_rep_cut),
      incomeTax: money(r.income_tax), localTax: money(r.local_tax), net: money(r.net),
      // 낱말을 내려보내지 않는다 — 화면이 그것으로 다시 판정하면 판정이 두 곳이 된다 (N-27)
      confirmed: payoutConfirmed(r.confirmed_by as string | null),
    }));

    const expRows = (await this.inv.query(
      `${EXPENSE_SELECT} ORDER BY e.state = 'pending' DESC, e.spend_on DESC, e.id DESC`,
    )) as Array<Record<string, unknown>>;
    const expenses: ExpenseDto[] = expRows.map((r) => this.expenseRow(r, canSeeAmounts));

    const totalRows = (await this.inv.query(EXPENSE_TOTAL_SQL)) as Array<Record<string, unknown>>;
    const expenseTotals: ExpenseTotalDto[] = totalRows.map((r) => {
      const category = String(r.category);
      return { category, categoryLabel: EXPENSE_CATEGORY_LABEL[category] ?? category, sum: money(r.sum) };
    });

    return {
      summary: await this.moneySummary(canSeeAmounts, today),
      invoices, payments, payouts, expenses, expenseTotals, payCategories,
      expenseCategories: EXPENSE_CATEGORIES.map((key) => ({ key, label: EXPENSE_CATEGORY_LABEL[key] ?? key })),
    };
  }

  /**
   * 회계 머리 여섯 칸 — §52·§56 원문 (C43).
   *
   * **목록에서 다시 더하지 않는다.** 권한이 없으면 목록의 금액은 이미 null 이라, 거기서 합을 내면
   * 대표가 아닌 사람에게는 0원이 되고 그 0원이 「진짜 0」처럼 보인다. 합은 DB 가 낸다.
   * 가리는 일은 마지막 한 줄에서만 한다 — 서버가 아예 안 내려보낸다 (D-R39).
   */
  private async moneySummary(canSeeAmounts: boolean, today: string): Promise<AccountingDto['summary']> {
    const [m] = (await this.inv.query(MONEY_SUMMARY_SQL, [today])) as Array<{
      sent: string; collected: string; overdue: string;
    }>;
    const [o] = (await this.inv.query(MONEY_OUT_SQL)) as Array<{ out: string }>;
    const [t] = (await this.inv.query(MONEY_TODO_SQL, [today])) as Array<{ n: string }>;

    const sent = Number(m.sent);
    const collected = Number(m.collected);
    const gate = (v: number): number | null => (canSeeAmounts ? v : null);
    return {
      sent: gate(sent),
      collected: gate(collected),
      // 원문 안에서 닫히는 산술이다 — 7,214,000 − 4,377,400 = 2,836,600 (§52)
      unpaid: gate(sent - collected),
      overdue: gate(Number(m.overdue)),
      net: gate(collected - Number(o.out)),
      todo: Number(t.n),
      canSeeAmounts,
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
  /**
   * 청구서 한 장을 낸다 (§53 「+ 새 청구서 발행」 · C50).
   *
   * **횟수는 서버가 센다.** 원문 명세가 그렇게 적어 두었다 —
   * 「INV_LINE 의 횟수는 `occ()` 가 센다 · 프론트가 세면 예외(EXC)를 빠뜨린다」(D-R37).
   * 그래서 이 경로는 줄을 **받지 않고 만든다**: 그 달의 취소 아닌 회차를 과목별로 세고,
   * 그날만 빠진 학생(`exc_stu_out`)은 빼고, 단가는 `rate` 에서 읽는다.
   *
   * 세는 자리가 하나여야 하는 이유는 단순하다 — 화면이 센 숫자를 받으면 예외가 늘 때마다
   * 두 숫자가 갈라지고, 갈라진 쪽이 청구서에 찍혀 나간다.
   *
   * **되돌리기는 없다**(원문 규칙 줄). 잘못 냈으면 취소(`void`)하고 새로 만든다 —
   * 그래서 여기서 하는 일은 INSERT 뿐이고 기존 행을 고치지 않는다.
   *
   * 한 학생의 한 달에 **같은 종류를 두 번** 내지 않는다. 두 장이 되면 「보낸 청구서」 합계가
   * 두 번 더해지고 §52 머리의 등식이 깨진다.
   */
  async issueInvoice(userId: number, dto: InvoiceIssueDto, canSeeAmounts: boolean, canVoidInvoice = false): Promise<InvoiceDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      // 마감 달에는 새 청구서를 내지 않는다 (C92-d · L-123) — 마감을 풀고 낸다
      await assertMonthOpen(m, dto.yearMonth);
      return this.issueOne(m, userId, dto, canSeeAmounts, canVoidInvoice);
    });
  }

  /**
   * §53 「청구서 일괄 발행」 — 그 달 수업이 있는 학생 전부 (C94-a · 테스트 시나리오 H-75 · O-147).
   *
   * **낱장 발행과 같은 함수**(`issueOne`)를 학생마다 부른다 — 이월(음수 줄)·단가 구간·「그날만 빠짐」·휴원이
   * 그대로 반영된다(「이월이 반영 안 되거나 금액이 틀리면 실패」). 한 학생이 막혀도(단가 없음 · 이미 있음 ·
   * 이월 초과) 나머지는 낸다 — SAVEPOINT 로 그 학생만 되돌리고 이유를 돌려준다. **건너뛴 학생을 숨기지 않는다.**
   * 마감 달은 통째로 409 — 마감을 풀고 낸다.
   */
  async issueBatch(userId: number, dto: InvoiceBatchDto, canSeeAmounts: boolean, canVoidInvoice = false): Promise<InvoiceBatchResultDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      await assertMonthOpen(m, dto.yearMonth);
      // §54 와 같은 집합 — 그 달에 회차가 하나라도 있는 학생
      const students = (await m.query(
        `SELECT DISTINCT st.id, st.name
           FROM ser_occ o
           JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
           JOIN stu st     ON st.id = ss.student_id
          WHERE ${kstMonthOf('lower(o.span)')} = $1
          ORDER BY st.name, st.id`,
        [dto.yearMonth],
      )) as Array<{ id: string; name: string }>;
      const issued: InvoiceDto[] = [];
      const skipped: InvoiceBatchSkipDto[] = [];
      for (const [i, st] of students.entries()) {
        const sp = `inv_batch_${i}`;
        await m.query(`SAVEPOINT ${sp}`);
        try {
          issued.push(await this.issueOne(m, userId, { studentId: Number(st.id), yearMonth: dto.yearMonth, invType: 'tuition' }, canSeeAmounts, canVoidInvoice));
          await m.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (e) {
          await m.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          if (e instanceof HttpException) {
            const body = e.getResponse() as { code?: string; message?: string };
            skipped.push({ studentId: Number(st.id), studentName: st.name, code: body.code ?? 'ERROR', message: body.message ?? e.message });
          } else {
            throw e;
          }
        }
      }
      return {
        yearMonth: dto.yearMonth, candidates: students.length, issued, skipped,
        issuedAmount: canSeeAmounts ? issued.reduce((n, inv) => n + (inv.amount ?? 0), 0) : null,
      };
    });
  }

  /** 「전달」 — 학부모께 보냈다 (H-76). 초안·미전달만 된다. 입금이 시작된 청구서는 이미 보낸 것이다 */
  async deliverInvoice(userId: number, id: number, canSeeAmounts: boolean, canVoidInvoice = false): Promise<InvoiceDto> {
    const today = todayKst();
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [inv] = (await m.query(`SELECT id, state::text AS state, year_month FROM inv WHERE id = $1 FOR UPDATE`, [id])) as Array<{ id: string; state: string; year_month: string }>;
      if (!inv) throw new NotFoundException({ code: 'INV_NOT_FOUND', message: '청구서를 찾을 수 없습니다' });
      if (!(INV_DELIVERABLE as readonly string[]).includes(inv.state)) {
        throw new ConflictException({ code: 'INV_NOT_DELIVERABLE', message: `이미 ${INV_STATE_LABEL[inv.state] ?? inv.state} 상태입니다 — 초안만 전달할 수 있습니다` });
      }
      await m.query(`UPDATE inv SET state = 'sent', sent_at = now() WHERE id = $1`, [id]);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'INV',$2,'deliver',$3::jsonb,$4::jsonb)`,
        [userId, id, JSON.stringify({ state: inv.state }), JSON.stringify({ state: 'sent' })],
      );
      const [row] = (await m.query(`${INV_SELECT} WHERE i.id = $1`, [id])) as Array<Record<string, unknown>>;
      return this.invoiceRow(row, canSeeAmounts, today, canVoidInvoice);
    });
  }

  /**
   * 「취소」 — 잘못 낸 청구서 (N-139 「대표 권한으로 수정 또는 삭제 · 직원이 지울 수 있으면 실패 · 이력에 남는다 · 미수가 다시 계산된다」).
   * 지우지 않는다 — `state = void` 로 접고 사유를 `detail.void` 에 남긴다(줄·발행일은 그대로). 입금이 있으면 먼저 입금을 지운다.
   * 미수 집계(`INV_BILLABLE`·`INV_OPEN`)는 void 를 이미 빼므로 다시 계산할 것이 없다.
   */
  async voidInvoice(userId: number, canVoidInvoice: boolean, id: number, dto: InvoiceVoidDto, canSeeAmounts: boolean): Promise<InvoiceDto> {
    if (!canVoidInvoice) throw new ForbiddenException({ code: 'FORBIDDEN', message: '청구서 취소는 대표만 할 수 있습니다' });
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: '취소 사유를 적어 주세요' });
    const today = todayKst();
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [inv] = (await m.query(
        `SELECT id, state::text AS state, year_month, amount, paid_amount FROM inv WHERE id = $1 FOR UPDATE`, [id],
      )) as Array<{ id: string; state: string; year_month: string; amount: number; paid_amount: number }>;
      if (!inv) throw new NotFoundException({ code: 'INV_NOT_FOUND', message: '청구서를 찾을 수 없습니다' });
      if (inv.state === 'void') throw new ConflictException({ code: 'INV_ALREADY_VOID', message: '이미 취소된 청구서입니다' });
      await assertMonthOpen(m, inv.year_month);
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM pay WHERE inv_id = $1`, [id])) as Array<{ n: number }>;
      if (n > 0 || Number(inv.paid_amount) > 0) {
        throw new ConflictException({ code: 'INV_HAS_PAYMENTS', message: '입금이 붙은 청구서는 취소할 수 없습니다 — 입금을 먼저 지우세요' });
      }
      await m.query(
        `UPDATE inv SET state = 'void',
                        detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('void', jsonb_build_object('reason', $2::text, 'by', $3::bigint, 'at', now()))
          WHERE id = $1`,
        [id, reason, userId],
      );
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'INV',$2,'void',$3::jsonb,$4::jsonb)`,
        [userId, id, JSON.stringify({ state: inv.state, amount: Number(inv.amount) }), JSON.stringify({ state: 'void', reason })],
      );
      const [row] = (await m.query(`${INV_SELECT} WHERE i.id = $1`, [id])) as Array<Record<string, unknown>>;
      return this.invoiceRow(row, canSeeAmounts, today, canVoidInvoice);
    });
  }

  /** 청구서 한 장 — 낱장 발행과 일괄 발행이 같은 줄·같은 거절을 쓴다 */
  private async issueOne(m: EntityManager, userId: number, dto: InvoiceIssueDto, canSeeAmounts: boolean, canVoidInvoice = false): Promise<InvoiceDto> {
    const today = todayKst();
    {
      const [stu] = (await m.query(`SELECT id, name FROM stu WHERE id = $1`, [dto.studentId])) as Array<{
        id: string; name: string;
      }>;
      if (!stu) throw new NotFoundException('학생을 찾을 수 없습니다');

      const dup = (await m.query(
        `SELECT id FROM inv
          WHERE student_id = $1 AND year_month = $2 AND inv_type = $3 AND state <> 'void'
          LIMIT 1`,
        [dto.studentId, dto.yearMonth, dto.invType],
      )) as Array<{ id: string }>;
      if (dup.length > 0) {
        throw new ConflictException({
          code: 'INV_DUPLICATE',
          message: `${dto.yearMonth} ${stu.name} 학생의 ${INV_TYPE_LABEL[dto.invType] ?? dto.invType}는 이미 있습니다 — 취소하고 새로 만드세요`,
        });
      }

      /*
       * 과목별 회차 수 — 취소된 회차와 「그날만 빠진」 학생은 빼고 센다.
       * 달은 회차의 **시작 시각을 KST 로 본 달**이다 (D-R12 · 시간대는 한 곳에서 정한다).
       *
       * ── 단가 (C63 교정) ────────────────────────────────────────────────
       * 원문 §54 — 「데이터 RATE(단가), STURATE(학생별 예외)」 ·
       * 「규칙 **그룹 수업은 인원이 늘면 1인 단가가 내려가고 총액은 올라갑니다**」 ·
       * 「연동 **청구서 생성 시 이 계산 결과를 씁니다**」.
       *
       * 그런데 여기가 **인원 구간도 학생 예외도 안 보고** 있었다. `rate` 는 같은 과목에
       * heads 1·2·3·4 네 줄을 갖는데 `ORDER BY sub_key, from_date DESC LIMIT 1` 은
       * 그 넷을 **가르지 못한다** — from_date 가 같으면 어느 줄이 나올지 DB 가 정한다.
       * 실제로 2인 AP Chem 이 1인 단가(₩80,000)로 청구되고 있었고, **같은 수업의 명단
       * 화면은 ₩45,000 을 보여 주고 있었다** (`lib/rules.rosterPricing` 은 구간을 본다).
       * 같은 수업에 값이 두 개인 상태였다 (D-R22).
       *
       * 그래서 회차마다 단가를 먼저 정하고 그 단가로 묶는다 —
       *   ① 인원 = 그 수업의 현재 명단 수. ② 그 인원 **이하의 가장 큰 구간**을 고른다.
       *   ③ 학생 예외(STURATE)가 있으면 그것이 이긴다.
       * 같은 과목이라도 단가가 다르면 **줄이 갈린다** — 「몇 번에 얼마」가 한 줄에서 읽혀야 한다.
       */
      const lines = await invoiceLines(m, dto.studentId, dto.yearMonth);

      if (lines.length === 0) {
        throw new ConflictException({
          code: 'INV_NO_LESSONS',
          message: `${dto.yearMonth} 에 ${stu.name} 학생의 수업이 없습니다 — 청구할 것이 없습니다`,
        });
      }
      const noRate = lines.filter((l) => l.unit_price == null).map((l) => l.label);
      if (noRate.length > 0) {
        // 단가를 0 으로 넣지 않는다 — 0 원 청구서는 조용히 틀린 청구서다
        throw new ConflictException({
          code: 'INV_NO_RATE',
          message: `단가표에 없는 과목이 있습니다: ${noRate.join(' · ')} — 단가를 먼저 등록하세요`,
        });
      }

      /*
       * 이월분이 이 달 청구에서 빠진다 (C92-b · 테스트 시나리오 C-35 「다음 달 청구 회차 = 예정 − 이월」).
       * 지난달에서 넘긴 `carry` 줄(to_month = 이 달)을 **음수 줄**로 얹는다 — 받아 놓고 못 해 준 회차의 값이라
       * 이번 달 회차에서 그만큼 뺀다. 넘긴 돈은 그때 굳힌 금액(carry.amount)이지 지금 단가로 다시 세지 않는다.
       * 수업료 청구서에만 붙는다 — 컨설팅비·응시료는 이월이 없다.
       */
      const carries = dto.invType === 'tuition' ? (await m.query(
        `SELECT from_month, amount, sessions FROM carry WHERE student_id = $1 AND to_month = $2 ORDER BY from_month, id`,
        [dto.studentId, dto.yearMonth],
      )) as Array<{ from_month: string; amount: number; sessions: number }> : [];
      const carriedIn = carries.reduce((n, c) => n + Number(c.amount), 0);
      const total = linesTotal(lines) - carriedIn;
      if (total < 0) {
        // 넘어온 돈이 이 달 수업보다 많다 — 청구서를 음수로 내지 않는다. 남는 돈을 어느 달로 넘길지는 사람이 정한다
        throw new ConflictException({
          code: 'INV_CARRY_EXCEEDS',
          message: `이월분(${won(carriedIn)})이 ${dto.yearMonth} 수업료(${won(linesTotal(lines))})보다 많습니다 — 청구서를 내기 전에 이월을 정리하세요`,
        });
      }
      const [ym, mm] = dto.yearMonth.split('-');
      const title = dto.title?.trim()
        || `${ym}년 ${Number(mm)}월 ${INV_TYPE_LABEL[dto.invType] ?? dto.invType}`;

      const [made] = (await m.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state,
                          issued_on, due_on, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6::date, $7::date, $8)
         RETURNING id`,
        [dto.studentId, dto.yearMonth, dto.invType, title, total, today, dto.dueOn ?? null, userId],
      )) as Array<{ id: string }>;
      const invId = Number(made.id);

      for (const [i, l] of lines.entries()) {
        await m.query(
          `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [invId, l.sub_key, l.label, l.n, l.unit_price, l.n * Number(l.unit_price), i],
        );
      }
      for (const [i, c] of carries.entries()) {
        // 음수 줄 — count 는 −회차, amount 는 −넘긴 돈. 단가는 표시용 평균(여러 과목이 섞여 정확한 단가가 없다)
        const sessions = Number(c.sessions);
        const amount = Number(c.amount);
        await m.query(
          `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [invId, `이월 (${c.from_month} 에서 ${sessions}회)`, -sessions, sessions > 0 ? Math.round(amount / sessions) : 0, -amount, lines.length + i],
        );
      }

      const [row] = (await m.query(`${INV_SELECT} WHERE i.id = $1`, [invId])) as Array<Record<string, unknown>>;
      return this.invoiceRow(row, canSeeAmounts, today, canVoidInvoice);
    }
  }

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

  /* ══ §54 수업료 계산 (C65) ═════════════════════════════════════════════
   * 원문 슬라이드 54 의 마지막 줄이 이 화면의 정체다 —
   * 「연동: **청구서 생성 시 이 계산 결과를 씁니다**」.
   * 그래서 **단가를 여기서 다시 세지 않는다.** 청구서가 쓰는 `invoice-lines.ts` 한 벌을
   * 그대로 부른다 (D-R22). 두 곳이 각자 계산하면 「미리 본 금액」과 「청구한 금액」이 갈린다.
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 그 달의 학생별 수업료. 세는 것도 나누는 것도 전부 서버다 (D-R37) —
   * 화면이 회차를 세면 취소·「그날만 빠진」을 빠뜨리고, 화면이 %를 내면 머리 칸과 갈린다.
   *
   * **결강은 금액에서 빠지고 「넘길 돈」으로 따로 선다.** 원문 표가 「결강」과 「넘길 돈」을
   * 나란히 두는 것이 그 뜻이다 — 안 한 수업을 이번 달에 청구하지 않는다.
   */
  async tuition(month: string, canSeeAmounts: boolean, canCloseMonth = false): Promise<TuitionDto> {
    const today = todayKst();
    // 월 마감 (C92-d) — 열려 있는 마감 하나. 단추가 서는지는 여기서 정한다 (D-R39)
    const close = await this.currentClose(this.inv.manager, month);
    const [span] = (await this.inv.query(
      `SELECT to_char(date_trunc('month', $1::date)::date, 'YYYY-MM-DD')                        AS first,
              to_char((date_trunc('month', $1::date) + interval '1 month - 1 day')::date, 'YYYY-MM-DD') AS last`,
      [`${month}-01`],
    )) as Array<{ first: string; last: string }>;
    const daysInMonth = Number(span.last.slice(8));
    // 「21일 지남 · 10일 남음」 — 오늘이 이 달 밖이면 통째로 지났거나 통째로 남았다
    const daysPast = today > span.last ? daysInMonth : today < span.first ? 0 : Number(today.slice(8));
    const daysLeft = daysInMonth - daysPast;

    /** 그 달에 회차가 하나라도 있는 학생만 — 이번 달 수업이 없는 학생은 줄을 만들지 않는다 */
    const students = (await this.inv.query(
      `SELECT DISTINCT st.id, st.name, st.grade
         FROM ser_occ o
         -- 수강 종료 뒤의 회차는 그 학생의 것이 아니다 (C94-c) — 그 달에 유효한 회차가 하나라도 있는 학생만
         JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
         JOIN stu st     ON st.id = ss.student_id
        WHERE ${kstMonthOf('lower(o.span)')} = $1
        ORDER BY st.name, st.id`,
      [month],
    )) as Array<{ id: string; name: string; grade: string | null }>;

    /**
     * 회차 한 줄 = 한 학생의 한 수업. 금액이 붙는 단위라 여기서 한 번만 읽는다.
     * `state` 는 세 가지다 — 이미 한 것 · 아직 안 한 것 · 결강(취소 또는 그날만 빠짐).
     */
    /*
     * 휴강의 처리가 갈래를 정한다 (C92 · invoice-lines.ts 와 같은 낱말) —
     *   차감(deduct)  → 소진: 한 수업·이번 달 전체에 들어가고 「차감 N」으로 따로 센다
     *   이월·보강 이관·그날만 빠짐 → 결강: 청구하지 않는다 (보강 이관은 넘길 돈에서도 빠진다)
     */
    const occRows = students.length ? (await this.inv.query(
      `SELECT ss.student_id,
              to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              o.canceled,
              -- 추가 수업(KIND.extra)은 회차로 세되 「추가」 칸에 따로 센다 (C-38 「정규 회차로 세어지면 실패」)
              (SELECT k.extra FROM ser s JOIN kind k ON k.key = s.kind_key WHERE s.id = o.ser_id) AS extra,
              (SELECT e.cancel_treat FROM exc e WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date) AS treat,
              (EXISTS (
                 SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                  WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND xo.student_id = ss.student_id
               ) OR ${stuPausedOn('ss.student_id', 'o.on_date')}) AS stu_out
         FROM ser_occ o
         JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
        WHERE ${kstMonthOf('lower(o.span)')} = $1
          AND ss.student_id = ANY($2::bigint[])`,
      [month, students.map((s) => Number(s.id))],
    )) as Array<{ student_id: string; on_date: string; canceled: boolean; extra: boolean | null; treat: string | null; stu_out: boolean }> : [];

    const counts = new Map<number, { done: number; total: number; canceled: number; deducted: number; extra: number }>();
    for (const r of occRows) {
      const k = Number(r.student_id);
      const c = counts.get(k) ?? { done: 0, total: 0, canceled: 0, deducted: 0, extra: 0 };
      const deducted = r.canceled && r.treat === 'deduct' && !r.stu_out;
      if (deducted) {
        // 소진 — 안 한 수업이지만 이번 달 회차로 센다 (C-31)
        c.total += 1; c.done += 1; c.deducted += 1;
      } else if (r.canceled || r.stu_out) c.canceled += 1;
      else {
        c.total += 1;
        if (r.on_date <= today) c.done += 1;
        // 추가 수업은 전체에 들되 따로도 센다 — 「이번 달 청구 회차 13 → 14 · 상단 추가 칸 +1」(C-38)
        if (r.extra === true) c.extra += 1;
      }
      counts.set(k, c);
    }

    /*
     * 이월 판정에 필요한 둘 — 대표 결정 N-39 「결제 됐으나 정해진 시수가 채워지지 않은 경우」.
     * ① 그 달 **완납된 수업료 청구서** ② 이미 넘긴 줄(한 달은 한 번만 넘긴다).
     * 셋째로 **지난달에서 넘어온 돈**도 같이 읽는다 — 그것이 이 달이 받은 것이다.
     */
    const paidInv = new Map<number, number>();
    for (const r of (await this.inv.query(
      `SELECT student_id, id FROM inv
        WHERE year_month = $1 AND inv_type = 'tuition' AND state = 'paid'`,
      [month],
    )) as Array<{ student_id: string; id: string }>) paidInv.set(Number(r.student_id), Number(r.id));

    const carriedOut = new Map<number, string>();
    for (const r of (await this.inv.query(
      `SELECT student_id, ${kstAt('at')} AS at FROM carry WHERE from_month = $1`, [month],
    )) as Array<{ student_id: string; at: string }>) carriedOut.set(Number(r.student_id), r.at);

    const carriedIn = new Map<number, { amount: number; sessions: number }>();
    for (const r of (await this.inv.query(
      `SELECT student_id, SUM(amount)::int AS amount, SUM(sessions)::int AS sessions FROM carry WHERE to_month = $1 GROUP BY student_id`,
      [month],
    )) as Array<{ student_id: string; amount: number; sessions: number }>) {
      carriedIn.set(Number(r.student_id), { amount: Number(r.amount), sessions: Number(r.sessions) });
    }

    const money = (v: number): number | null => (canSeeAmounts ? v : null);
    const items: TuitionRowDto[] = [];
    let doneCount = 0, totalCount = 0, canceledCount = 0, deductedCount = 0, extraCount = 0, doneAmount = 0, carryAmount = 0;
    let carriedInCount = 0, carriedInAmount = 0;

    for (const s of students) {
      const id = Number(s.id);
      const c = counts.get(id) ?? { done: 0, total: 0, canceled: 0, deducted: 0, extra: 0 };
      // 청구서와 **같은 함수**다 — 미리 본 금액과 청구한 금액이 갈리지 않는다
      const lines = await invoiceLines(this.inv, id, month);
      const priced = lines.filter((l) => l.unit_price !== null);
      /** 1회 평균이 아니라 **가장 많이 쓰인 단가**다 — 평균은 어느 수업의 값도 아니다 */
      const top = priced.reduce<{ n: number; unit: number } | null>(
        (best, l) => (best === null || l.n > best.n ? { n: l.n, unit: Number(l.unit_price) } : best), null);
      /*
       * 「지금까지」와 「넘길 돈」도 **나누어 내지 않고 다시 센다.**
       * 달 총액을 회차 수로 가르면 과목마다 단가가 다른 학생에게서 **어느 수업의 값도 아닌 숫자**가 나온다
       * (SAT 8만 8회 + 모의 4.5만 3회 중 7회를 했을 때 × 7/11 은 어느 조합과도 안 맞는다).
       * 같은 질의를 날짜로 좁혀 다시 세면 단가 규칙이 갈릴 일도 없다 — invoice-lines.ts 의 토막 주석.
       */
      const sliced = async (slice: LineSlice): Promise<number> =>
        linesTotal((await invoiceLines(this.inv, id, month, slice)).filter((l) => l.unit_price !== null));
      const done = await sliced({ kind: 'done', upto: today });
      const carry = await sliced({ kind: 'dropped' });

      const [override] = (await this.inv.query(
        // 「개별 단가」 표시는 **그 달 안에** 살아 있는 예외가 있는가다 — 다음 달부터의 예외를 이번 달 표가 「일반」이라 적으면
        // 옆 칸의 단가(그 달 회차의 값)와 어긋난다 (C94-d)
        `SELECT 1 AS hit FROM sturate su WHERE su.student_id = $1 AND su.from_date <= $2::date LIMIT 1`,
        [id, span.last],
      )) as Array<{ hit: number }>;

      const got = carriedIn.get(id) ?? { amount: 0, sessions: 0 };
      doneCount += c.done; totalCount += c.total; canceledCount += c.canceled; deductedCount += c.deducted; extraCount += c.extra;
      doneAmount += done; carryAmount += carry;
      carriedInCount += got.sessions; carriedInAmount += got.amount;
      items.push({
        studentId: id, name: s.name, grade: s.grade ?? null,
        done: c.done, total: c.total,
        // 나누는 것도 서버다 — 화면이 다시 나누면 머리 칸과 갈린다 (D-R37)
        percent: c.total > 0 ? Math.round((c.done / c.total) * 100) : 0,
        canceled: c.canceled,
        deducted: c.deducted,
        extra: c.extra,
        unitPrice: money(top?.unit ?? 0),
        unitPriceOverride: override !== undefined,
        // 단가가 둘 이상이면 화면이 하나를 적지 않는다 — 곱해서 안 맞는 숫자를 세우지 않는다
        priceCount: new Set(priced.map((l) => Number(l.unit_price))).size,
        doneAmount: money(done), carryAmount: money(carry),
        /*
         * **받아 놓고 못 해 준 수업**만 이월이다 (N-39). 완납이 아니면 이월할 것이 없고,
         * 못 해 준 수업이 없어도 없다. 이미 넘겼으면 다시 못 넘긴다 — 같은 돈이 두 번 넘어간다.
         */
        carryable: paidInv.has(id) && carry > 0 && !carriedOut.has(id),
        carriedAt: carriedOut.get(id) ?? null,
        carriedIn: money(got.amount),
        carriedInSessions: got.sessions,
        // 금액을 못 보면 내역도 안 내려간다 — 줄을 세면 금액이 드러난다 (§27·§28 과 같은 규약)
        lines: canSeeAmounts
          ? priced.map((l) => ({
            subKey: l.sub_key, label: l.label, count: l.n,
            unitPrice: Number(l.unit_price), amount: l.n * Number(l.unit_price),
          }))
          : [],
      });
    }

    return {
      month, today, daysPast, daysLeft,
      doneCount, totalCount, canceledCount, deductedCount, extraCount,
      doneAmount: money(doneAmount), carryAmount: money(carryAmount),
      carriedInCount, carriedInAmount: money(carriedInAmount),
      items, canSeeAmounts,
      close,
      // 아직 시작하지 않은 달은 마감할 것이 없다 — 오늘이 그 달 1일 이후여야 한다
      canClose: canCloseMonth && close === null && today >= span.first,
      canReopen: canCloseMonth && close !== null,
    };
  }

  /* ── §57 강사료 시트 · 지급 확정 (C94-b · H-82 · O-148 · D-43) ──────────────
     세는 것은 `lib/payout-sheet` 한 곳 — 강사 히스토리(§57 강사 화면)가 같은 함수를 쓴다.
     「리포트를 썼는가」만 본다(D-R7) · 미작성은 빠지고 얼마가 빠지는지 센다(D-43) · 휴강은 시수에 안 든다(H-82).
     확정은 **그 순간의 계산을 굳힌다** — 저장된 초안이 있어도 계산이 이긴다(초안과 다르면 줄에 함께 보인다).
     `payout_line` 은 쓰지 않는다 — N-36(빈 표 넷) 결정 전이다.                                  */

  private async payoutSheetRow(
    m: { query: EntityManager['query'] }, staff: { id: number; name: string }, month: string,
    today: string, nowMin: number, canSeeAmounts: boolean, canConfirmPayout: boolean, monthEnded: boolean,
  ): Promise<PayoutSheetRowDto> {
    const sheet = await payoutSheet(m, staff.id, month, today, nowMin);
    const [po] = (await m.query(
      `SELECT po.net, po.confirmed_by, po.confirmed_at, cb.name AS confirmed_name
         FROM payout po LEFT JOIN staff cb ON cb.id = po.confirmed_by
        WHERE po.staff_id = $1 AND po.year_month = $2`,
      [staff.id, month],
    )) as Array<{ net: number; confirmed_by: string | null; confirmed_at: Date | null; confirmed_name: string | null }>;
    const money = (v: number): number | null => (canSeeAmounts ? v : null);
    const confirmed = po ? payoutConfirmed(po.confirmed_by) : false;
    const { agg } = sheet;
    return {
      staffId: staff.id, staffName: staff.name, yearMonth: month,
      writtenCount: agg.writtenCount, writtenMinutes: agg.writtenMinutes,
      unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes,
      canceledCount: agg.canceledCount, naCount: agg.naCount, noRateCount: agg.noRateCount,
      gross: money(agg.gross), lateCut: money(agg.lateCut), incomeTax: money(sheet.incomeTax), localTax: money(sheet.localTax),
      net: money(sheet.net), unwrittenAmount: money(agg.unwrittenAmount),
      saved: !!po, savedDiffers: !!po && Number(po.net) !== sheet.net, savedNet: po ? money(Number(po.net)) : null,
      confirmed,
      confirmedAt: po?.confirmed_at ? new Date(po.confirmed_at).toISOString() : null,
      confirmedBy: po?.confirmed_name ?? null,
      canConfirm: canConfirmPayout && monthEnded && !confirmed && agg.noRateCount === 0 && agg.writtenCount > 0,
    };
  }

  /** 그 달의 강사 — 활동 중인 강사 전부 + 그 달 회차를 맡은 사람(강사가 아니어도) */
  private async payoutStaff(m: { query: EntityManager['query'] }, month: string): Promise<Array<{ id: number; name: string }>> {
    const rows = (await m.query(
      `SELECT DISTINCT st.id, st.name
         FROM staff st
        WHERE (st.role = 'teacher' AND st.active)
           OR st.id IN (
             SELECT ${TEACHER_OF_OCC} FROM ser_occ o JOIN ser s ON s.id = o.ser_id
              WHERE o.on_date >= $1::date AND o.on_date < $1::date + interval '1 month'
                AND ${TEACHER_OF_OCC} IS NOT NULL)
        ORDER BY st.name, st.id`,
      [`${month}-01`],
    )) as Array<{ id: string; name: string }>;
    return rows.map((r) => ({ id: Number(r.id), name: r.name }));
  }

  async payoutSheetOf(month: string, canSeeAmounts: boolean, canConfirmPayout: boolean): Promise<PayoutSheetDto> {
    const today = todayKst();
    const nowMin = nowMinKst();
    const monthEnded = today.slice(0, 7) > month;
    const staff = await this.payoutStaff(this.inv.manager, month);
    const rows: PayoutSheetRowDto[] = [];
    for (const st of staff) rows.push(await this.payoutSheetRow(this.inv.manager, st, month, today, nowMin, canSeeAmounts, canConfirmPayout, monthEnded));
    return {
      month, today, monthEnded, rows,
      unwrittenCount: rows.reduce((n, r) => n + r.unwrittenCount, 0),
      netTotal: canSeeAmounts ? rows.reduce((n, r) => n + (r.net ?? 0), 0) : null,
      canSeeAmounts,
    };
  }

  /**
   * 「지급 확정」 — 대표 전용 (O-148). 그 순간의 시트를 payout 행으로 굳히고 누가·언제를 남긴다.
   * 달이 끝나기 전에는 안 된다(끝나기 전 리포트가 더 들어온다) · 시급 없는 수업이 있으면 안 된다(0원으로 굳히면 조용히 틀린 정산) ·
   * 이미 확정이면 409. LOG `PAYOUT confirm`. `payout_line` 은 쓰지 않는다(N-36).
   */
  async confirmPayout(userId: number, canConfirmPayout: boolean, month: string, dto: PayoutConfirmDto, canSeeAmounts: boolean): Promise<PayoutSheetRowDto> {
    if (!canConfirmPayout) throw new ForbiddenException({ code: 'FORBIDDEN', message: '지급 확정은 대표만 할 수 있습니다' });
    const today = todayKst();
    const nowMin = nowMinKst();
    if (!(today.slice(0, 7) > month)) {
      throw new BadRequestException({ code: 'PAYOUT_MONTH_OPEN', message: '아직 끝나지 않은 달은 확정할 수 없습니다 — 리포트가 더 들어옵니다' });
    }
    return this.inv.manager.transaction(async (m: EntityManager) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payout:${dto.staffId}:${month}`]);
      const [st] = (await m.query(`SELECT id, name FROM staff WHERE id = $1`, [dto.staffId])) as Array<{ id: string; name: string }>;
      if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '강사를 찾을 수 없습니다' });
      const sheet = await payoutSheet(m, dto.staffId, month, today, nowMin);
      const [before] = (await m.query(
        `SELECT id, hours, gross, late_rep_cut, income_tax, local_tax, net, confirmed_by FROM payout WHERE staff_id = $1 AND year_month = $2 FOR UPDATE`,
        [dto.staffId, month],
      )) as Array<Record<string, unknown>>;
      if (before && payoutConfirmed(before.confirmed_by as string | null)) {
        throw new ConflictException({ code: 'PAYOUT_ALREADY_CONFIRMED', message: '이미 확정한 정산입니다' });
      }
      if (sheet.agg.noRateCount > 0) {
        throw new ConflictException({ code: 'PAYOUT_NO_RATE', message: `시급이 없는 수업이 ${sheet.agg.noRateCount}건 있습니다 — 시급을 먼저 등록하세요` });
      }
      if (sheet.agg.writtenCount === 0) {
        throw new ConflictException({ code: 'PAYOUT_NOTHING', message: '리포트를 쓴 수업이 없습니다 — 확정할 것이 없습니다' });
      }
      const hours = (sheet.agg.writtenMinutes / 60).toFixed(2);
      await m.query(
        `INSERT INTO payout (staff_id, year_month, hours, gross, late_rep_cut, income_tax, local_tax, net, state, confirmed_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, now())
         ON CONFLICT (staff_id, year_month) DO UPDATE
           SET hours = EXCLUDED.hours, gross = EXCLUDED.gross, late_rep_cut = EXCLUDED.late_rep_cut,
               income_tax = EXCLUDED.income_tax, local_tax = EXCLUDED.local_tax, net = EXCLUDED.net,
               state = 'confirmed', confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
        [dto.staffId, month, hours, sheet.agg.gross, sheet.agg.lateCut, sheet.incomeTax, sheet.localTax, sheet.net, userId],
      );
      const [row] = (await m.query(`SELECT id FROM payout WHERE staff_id = $1 AND year_month = $2`, [dto.staffId, month])) as Array<{ id: string }>;
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'PAYOUT',$2,'confirm',$3::jsonb,$4::jsonb)`,
        [userId, Number(row.id),
          before ? JSON.stringify({ hours: String(before.hours), gross: Number(before.gross), net: Number(before.net) }) : null,
          JSON.stringify({ month, hours, gross: sheet.agg.gross, lateCut: sheet.agg.lateCut, net: sheet.net, written: sheet.agg.writtenCount, unwritten: sheet.agg.unwrittenCount, canceled: sheet.agg.canceledCount, na: sheet.agg.naCount })],
      );
      return this.payoutSheetRow(m, { id: Number(st.id), name: st.name }, month, today, nowMin, canSeeAmounts, canConfirmPayout, true);
    });
  }

  /* ── 월 마감 (C92-d · 테스트 시나리오 C-39 · L-123 · N-140) ─────────────
     「마감 후에도 자유롭게 고쳐지면 실패 · 이월 확정분이 바뀌지 않는다 · 흔적 없이 고쳐지면 실패」.
     마감은 행 하나, 해제는 그 행에 누가·언제·왜(지우지 않는다), 다시 마감하면 새 행.
     막는 쪽은 `lib/month-close` 한 곳 — 스케줄·출결·청구·이월·휴원이 같은 판정을 쓴다.        */

  private async currentClose(m: { query: EntityManager['query'] }, month: string): Promise<MonthCloseDto | null> {
    const [row] = (await m.query(
      `SELECT c.id, c.year_month, c.closed_at, cb.name AS closed_by, c.reopened_at, rb.name AS reopened_by, c.reopen_reason
         FROM month_close c
         JOIN staff cb ON cb.id = c.closed_by
         LEFT JOIN staff rb ON rb.id = c.reopened_by
        WHERE c.year_month = $1 AND c.reopened_at IS NULL
        ORDER BY c.id DESC LIMIT 1`,
      [month],
    )) as Array<Record<string, unknown>>;
    return row ? AccountingService.toMonthClose(row) : null;
  }

  private static toMonthClose(r: Record<string, unknown>): MonthCloseDto {
    return {
      id: Number(r.id), month: String(r.year_month),
      closedAt: new Date(r.closed_at as string).toISOString(), closedBy: String(r.closed_by),
      reopenedAt: r.reopened_at ? new Date(r.reopened_at as string).toISOString() : null,
      reopenedBy: (r.reopened_by as string | null) ?? null,
      reopenReason: (r.reopen_reason as string | null) ?? null,
    };
  }

  /** 「N월 마감하기」 — 대표 전용. 이미 마감이면 409 `MONTH_ALREADY_CLOSED`, 아직 시작 안 한 달은 400 */
  async closeMonth(userId: number, canCloseMonth: boolean, dto: MonthCloseWriteDto): Promise<MonthCloseDto> {
    if (!canCloseMonth) throw new ForbiddenException({ code: 'FORBIDDEN', message: '월 마감은 대표만 할 수 있습니다' });
    if (`${dto.month}-01` > todayKst()) {
      throw new BadRequestException({ code: 'MONTH_NOT_STARTED', message: '아직 시작하지 않은 달은 마감할 수 없습니다' });
    }
    return this.inv.manager.transaction(async (m) => {
      // 같은 달의 마감 두 번을 직렬화한다 — 부분 유니크가 최종 방어선이다
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`month_close:${dto.month}`]);
      if (await this.currentClose(m, dto.month)) {
        throw new ConflictException({ code: 'MONTH_ALREADY_CLOSED', message: '이미 마감된 달입니다' });
      }
      const [row] = (await m.query(
        `INSERT INTO month_close (year_month, closed_by) VALUES ($1, $2) RETURNING id`,
        [dto.month, userId],
      )) as Array<{ id: string }>;
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'MONTH_CLOSE',$2,'close',$3::jsonb)`,
        [userId, Number(row.id), JSON.stringify({ month: dto.month })],
      );
      return (await this.currentClose(m, dto.month))!;
    });
  }

  /** 「마감 해제」 — 대표 전용 · 사유 필수. 행은 남고 `reopened_*` 가 채워진다 (N-140 「흔적 없이 고쳐지면 실패」) */
  async reopenMonth(userId: number, canCloseMonth: boolean, dto: MonthReopenWriteDto): Promise<MonthCloseDto> {
    if (!canCloseMonth) throw new ForbiddenException({ code: 'FORBIDDEN', message: '마감 해제는 대표만 할 수 있습니다' });
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: '해제 사유를 적어 주세요' });
    return this.inv.manager.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`month_close:${dto.month}`]);
      const open = await this.currentClose(m, dto.month);
      if (!open) throw new ConflictException({ code: 'MONTH_NOT_CLOSED', message: '마감되지 않은 달입니다' });
      await m.query(
        `UPDATE month_close SET reopened_by = $2, reopened_at = now(), reopen_reason = $3 WHERE id = $1`,
        [open.id, userId, reason],
      );
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'MONTH_CLOSE',$2,'reopen',$3::jsonb,$4::jsonb)`,
        [userId, open.id, JSON.stringify({ month: dto.month, closedAt: open.closedAt }), JSON.stringify({ month: dto.month, reason })],
      );
      const [row] = (await m.query(
        `SELECT c.id, c.year_month, c.closed_at, cb.name AS closed_by, c.reopened_at, rb.name AS reopened_by, c.reopen_reason
           FROM month_close c JOIN staff cb ON cb.id = c.closed_by LEFT JOIN staff rb ON rb.id = c.reopened_by
          WHERE c.id = $1`,
        [open.id],
      )) as Array<Record<string, unknown>>;
      return AccountingService.toMonthClose(row!);
    });
  }

  /**
   * §57 「그 밖의 수입 — 수업료가 아닌 돈 · 누르면 자세히 봅니다」.
   *
   * 컷은 줄 셋이고 줄마다 **건수 · 금액 · 「받음 ₩N」 · 「청구 안 함 N」**이다.
   * 종류 셋은 대표가 정한 `INV_TYPES_OTHER` 그대로다 (N-37 · C64).
   *
   * **데이터가 0건이어도 줄은 선다** — 종류는 어휘이지 데이터가 아니다.
   * 그 달에 진단고사 청구가 없다고 줄이 사라지면, 화면이 「이 학원은 진단고사를 안 한다」고
   * 말하는 셈이 된다.
   *
   * ── 「청구 안 함 N」을 무엇으로 읽었는가 (N-37 ②) ─────────────────────────
   * 원문이 뜻을 적지 않았다. 후보가 둘이었다 —
   *   ⓐ **아직 초안인 청구서**(`state = 'draft'`) — 「아직 청구하지 않았다」의 유일한 기존 표현이다.
   *   ⓑ **청구서 없이 받은 돈** — 컨설팅의 `cons_pay`(C58) 같은 것.
   * **ⓑ 는 성립할 수 없다.** 컷은 세 종류 **모두**에 이 뱃지를 다는데, MAP·CAT 응시료에는
   * 그런 표가 없고 만들려면 종류마다 새 표가 필요하다. 원문이 표 셋을 말한 적도 없다.
   * ⓐ 는 **있는 칸으로 곧게 읽은 것**이고 §52 머리의 「보낸 청구서」가 초안을 빼는 것과 같은 어휘다.
   * 틀렸다면 고칠 자리는 **이 메서드 하나**다 (C52 의 `useVersion` 과 같은 약속).
   *
   * **기간을 달지 않는다.** 컷 오른쪽의 「일별 · 주별 · 월별」은 **눌렀을 때 무엇이 달라지는지를
   * 컷이 한 번도 보여 주지 않는다.** 읽기마다 숫자의 뜻이 달라지므로 만들지 않았다 (N-40).
   * 지금 이 줄은 §52 머리 여섯 칸과 같은 **전 기간**이다 (C43 이 같은 이유로 월 라벨을 달지 않았다).
   */
  async otherIncome(canSeeAmounts: boolean, span: IncomeSpan = 'month'): Promise<OtherIncomeDto> {
    const types = [...INV_TYPES_OTHER];
    const rows = (await this.inv.query(
      `SELECT i.id, i.inv_type, i.title, i.amount, i.paid_amount,
              i.state::text AS state,
              to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
              to_char(i.due_on,'YYYY-MM-DD')    AS due_on,
              s.name AS student_name
         FROM inv i
         LEFT JOIN stu s ON s.id = i.student_id
        WHERE i.inv_type = ANY($1::text[]) AND i.state <> 'void'
        ORDER BY i.issued_on DESC NULLS LAST, i.id DESC`,
      [types],
    )) as Array<{
      id: string; inv_type: string; title: string | null; amount: number; paid_amount: number;
      state: string; issued_on: string | null; due_on: string | null; student_name: string | null;
    }>;

    const money = (v: number): number | null => (canSeeAmounts ? v : null);
    return {
      canSeeAmounts, span,
      rows: types.map((key) => {
        const mine = rows.filter((r) => r.inv_type === key);
        // 「보낸 청구서」와 같은 어휘다 — 초안은 아직 보낸 것이 아니다 (§52 머리 · INV_BILLABLE)
        const billed = mine.filter((r) => (INV_BILLABLE as readonly string[]).includes(r.state));
        return {
          key,
          label: INV_TYPE_ROW[key] ?? INV_TYPE_LABEL[key],
          sub: INV_TYPE_SUB[key],
          count: billed.length,
          unbilled: mine.filter((r) => r.state === 'draft').length,
          amount: money(billed.reduce((n, r) => n + Number(r.amount), 0)),
          paid: money(billed.reduce((n, r) => n + Number(r.paid_amount), 0)),
          /*
           * 펼쳤을 때의 **날짜 묶음** (N-40). 눈금은 `span` 이 정하고 **줄의 숫자는 안 바뀐다** —
           * 접힌 줄은 여전히 전 기간의 합계다. 묶음의 합계도 서버가 센다 (D-R37).
           */
          groups: groupBySpan(mine, span).map((g) => ({
            key: g.key,
            label: g.label,
            count: g.rows.length,
            amount: money(g.rows.reduce((n, r) => n + Number(r.amount), 0)),
            paid: money(g.rows.reduce((n, r) => n + Number(r.paid_amount), 0)),
            items: g.rows.map((r) => ({
              invId: Number(r.id),
              studentName: r.student_name ?? '학생 없음',
              title: r.title ?? INV_TYPE_ROW[key] ?? key,
              // 낱말은 서버가 짓는다 — 화면이 코드값을 찍지 않는다 (D-R18)
              stateLabel: INV_STATE_LABEL[r.state] ?? r.state,
              unbilled: r.state === 'draft',
              issuedOn: r.issued_on, dueOn: r.due_on,
              amount: money(Number(r.amount)), paid: money(Number(r.paid_amount)),
            })),
          })),
        };
      }),
    };
  }

  /**
   * §52 회계 트래킹 보드 — 대표 결정 2026-09-13 (N-28 「단일 진실원과 자동 전이에 유리하게」).
   *
   * **칸은 `inv.state` 하나로 갈린다** (`invBoardColumn` 한 함수). 「50% 냄」·「연체」는
   * 칸을 정하는 값이 아니라 **카드에 적히는 값**이다 — 두 축으로 가르면 판정이 두 벌이 된다.
   *
   * **칸은 비어도 선다** — 칸은 어휘이지 데이터가 아니다 (§57 줄 셋과 같은 규약 · C66).
   * 건수·합계도 서버가 센다 — 화면이 배열을 세면 안 보이는 카드까지 세거나 빠뜨린다 (D-R37).
   */
  async invoiceBoard(canSeeAmounts: boolean): Promise<InvBoardDto> {
    const today = todayKst();
    const rows = (await this.inv.query(
      `SELECT i.id, i.student_id, s.name AS student_name, s.grade,
              i.inv_type, i.title, i.amount, i.paid_amount, i.state::text AS state,
              to_char(i.due_on,'YYYY-MM-DD') AS due_on
         FROM inv i
         LEFT JOIN stu s ON s.id = i.student_id
        WHERE i.state <> 'void'
        ORDER BY i.due_on NULLS LAST, i.id`,
    )) as Array<{
      id: string; student_id: string; student_name: string | null; grade: string | null;
      inv_type: string; title: string | null; amount: number; paid_amount: number;
      state: string; due_on: string | null;
    }>;

    const money = (v: number): number | null => (canSeeAmounts ? v : null);
    return {
      canSeeAmounts,
      columns: INV_BOARD_COLUMNS.map((col) => {
        const mine = rows.filter((r) => invBoardColumn(r.state) === col.key);
        return {
          key: col.key, label: col.label, sub: col.sub,
          count: mine.length,
          amount: money(mine.reduce((n, r) => n + Number(r.amount), 0)),
          cards: mine.map((r) => {
            const due = r.due_on;
            /*
             * 연체는 **아직 받을 돈이 있는 건**에만 붙는다 — `INV_OPEN` 이 그 집합이고
             * §52 머리의 「기한 지남」도 같은 집합을 쓴다. 초안은 아직 청구한 것이 아니라 연체가 아니고,
             * 완납은 받을 돈이 없어 연체가 아니다. 같은 낱말을 두 곳이 다르게 세지 않는다.
             */
            const owed = (INV_OPEN as readonly string[]).includes(r.state);
            const overdueDays = owed && due && due < today ? daysBetween(due, today) : 0;
            return {
              invId: Number(r.id), studentId: Number(r.student_id),
              studentName: r.student_name ?? '학생 없음', grade: r.grade ?? null,
              invType: r.inv_type, invTypeLabel: INV_TYPE_LABEL[r.inv_type] ?? r.inv_type,
              title: r.title ?? INV_TYPE_ROW[r.inv_type] ?? r.inv_type,
              stateLabel: INV_STATE_LABEL[r.state] ?? r.state,
              amount: money(Number(r.amount)), paid: money(Number(r.paid_amount)),
              /*
               * 컷의 「50% 냄」. 일부 납부에만 붙고, **금액을 못 보면 비율도 안 준다** —
               * 비율과 받은 돈이 같이 있으면 청구액이 복원된다 (D-R39).
               */
              paidPercent: canSeeAmounts && r.state === 'partial' && Number(r.amount) > 0
                ? Math.round((Number(r.paid_amount) / Number(r.amount)) * 100)
                : null,
              dueOn: due,
              overdueDays,
              whenLabel: invWhenLabel(due, today, overdueDays),
            };
          }),
        };
      }),
    };
  }

  /**
   * §54 「이월 처리」 — **받아 놓고 못 해 준 수업**을 다음 달로 넘긴다 (대표 결정 2026-09-13 · N-39).
   *
   * 「이월 처리는 **수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」.
   * 그래서 거절이 셋이다 —
   *   · `CARRY_NOT_PAID`   그 달 수업료 청구서가 완납이 아니다. **돈을 안 받았으면 넘길 것이 없다**
   *   · `CARRY_NOTHING`    못 해 준 수업이 없다
   *   · `CARRY_DUPLICATE`  이미 넘겼다 — 두 번 누르면 같은 돈이 두 번 넘어간다
   *
   * **판정은 `tuition()` 이 쓰는 것과 같은 값**이다 — 화면에 단추가 서는 조건과 서버가 받아 주는
   * 조건이 갈리면 「눌리는데 거절당하는 단추」가 된다 (D-R39).
   *
   * 넘기는 달은 **바로 다음 달**이다. 원문이 「다음 달로 넘길 돈」이라 적는다.
   */
  async carryTuition(userId: number, dto: TuitionCarryDto): Promise<CarryRowDto> {
    return this.inv.manager.transaction(async (m) => {
      // 마감 달의 이월 확정분은 바뀌지 않는다 (L-123) — 넘기는 달도, 받는 달도 열려 있어야 한다
      await assertMonthOpen(m, dto.month);
      const [inv] = (await m.query(
        `SELECT id FROM inv
          WHERE student_id = $1 AND year_month = $2 AND inv_type = 'tuition' AND state = 'paid'
          FOR UPDATE`,
        [dto.studentId, dto.month],
      )) as Array<{ id: string }>;
      if (!inv) {
        throw new ConflictException({
          code: 'CARRY_NOT_PAID',
          message: '그 달 수업료 청구서가 완납이 아닙니다 — 받지 않은 돈은 넘길 것이 없습니다',
        });
      }

      // 못 해 준 수업 = 휴강·결강한 회차. `tuition()` 의 「넘길 돈」과 **같은 질의**다
      const dropped = (await invoiceLines(m, dto.studentId, dto.month, { kind: 'dropped' }))
        .filter((l) => l.unit_price !== null);
      const amount = linesTotal(dropped);
      const sessions = dropped.reduce((n, l) => n + l.n, 0);
      if (amount <= 0 || sessions <= 0) {
        throw new ConflictException({
          code: 'CARRY_NOTHING',
          message: '못 해 준 수업이 없습니다 — 넘길 것이 없습니다',
        });
      }

      const [dup] = (await m.query(
        `SELECT id FROM carry WHERE student_id = $1 AND from_month = $2`, [dto.studentId, dto.month],
      )) as Array<{ id: string }>;
      if (dup) {
        throw new ConflictException({
          code: 'CARRY_DUPLICATE',
          message: '이미 넘긴 달입니다 — 한 달은 한 번만 넘깁니다',
        });
      }

      const [made] = (await m.query(
        `INSERT INTO carry (student_id, from_month, to_month, amount, sessions, inv_id, by_id)
         VALUES ($1, $2, to_char((($2 || '-01')::date + interval '1 month'), 'YYYY-MM'), $3, $4, $5, $6)
         RETURNING id, to_month, ${kstAt('at')} AS at`,
        [dto.studentId, dto.month, amount, sessions, Number(inv.id), userId],
      )) as Array<{ id: string; to_month: string; at: string }>;

      return {
        id: Number(made.id), studentId: dto.studentId,
        fromMonth: dto.month, toMonth: made.to_month,
        amount, sessions, invId: Number(inv.id), at: made.at,
      };
    });
  }

  /* ══ 단가표 · 학생별 예외 · 지출 등록 (C94-d · H-81 · H-83 · C-38) ═══════════════════
   * 청구서·§54·명단 가격이 이미 읽는 `rate`·`sturate` 에 **쓰는 길**이 없었다(시드뿐).
   * 여기서는 줄 하나를 더할 뿐이고 **셈은 한 곳도 바뀌지 않는다** — `invoice-lines.ts` 가 `from_date` 로
   * 그 날짜의 단가를 고르므로 새 줄은 그 날짜부터 모든 화면에 같이 든다. 지난 줄은 고치지도 지우지도
   * 않는다 — 이미 낸 청구서가 그 값으로 서 있다(C63).
   * ═══════════════════════════════════════════════════════════════════════════════ */

  private static readonly RATE_SELECT = `
    SELECT r.id, r.kind_key, k.name AS kind_name, k.extra AS kind_extra, r.sub_key, sb.name AS sub_name,
           r.heads, r.unit_price, to_char(r.from_date,'YYYY-MM-DD') AS from_date,
           (r.from_date <= $1::date AND r.from_date = (
              SELECT max(x.from_date) FROM rate x
               WHERE x.kind_key = r.kind_key AND x.sub_key IS NOT DISTINCT FROM r.sub_key AND x.heads = r.heads
                 AND x.from_date <= $1::date)) AS current
      FROM rate r
      JOIN kind k ON k.key = r.kind_key
      LEFT JOIN sub sb ON sb.key = r.sub_key`;

  private static readonly STURATE_SELECT = `
    SELECT su.id, su.student_id, st.name AS student_name, su.kind_key, k.name AS kind_name,
           su.unit_price, to_char(su.from_date,'YYYY-MM-DD') AS from_date, su.reason, w.name AS by_name,
           ${kstAt('su.created_at')} AS created_at,
           (su.from_date <= $1::date AND su.from_date = (
              SELECT max(x.from_date) FROM sturate x
               WHERE x.student_id = su.student_id AND x.kind_key IS NOT DISTINCT FROM su.kind_key
                 AND x.from_date <= $1::date)) AS current
      FROM sturate su
      JOIN stu st ON st.id = su.student_id
      LEFT JOIN kind k ON k.key = su.kind_key
      LEFT JOIN staff w ON w.id = su.by_id`;

  private rateRow(r: Record<string, unknown>): RateRowDto {
    return {
      id: Number(r.id), kindKey: String(r.kind_key), kindName: String(r.kind_name), kindExtra: r.kind_extra === true,
      subKey: (r.sub_key as string | null) ?? null, subName: (r.sub_name as string | null) ?? null,
      heads: Number(r.heads), unitPrice: Number(r.unit_price), fromDate: String(r.from_date), current: r.current === true,
    };
  }

  private studentRateRow(r: Record<string, unknown>): StudentRateRowDto {
    return {
      id: Number(r.id), studentId: Number(r.student_id), studentName: String(r.student_name),
      kindKey: (r.kind_key as string | null) ?? null, kindName: (r.kind_name as string | null) ?? null,
      unitPrice: Number(r.unit_price), fromDate: String(r.from_date),
      reason: (r.reason as string | null) ?? null, byName: (r.by_name as string | null) ?? null,
      createdAt: (r.created_at as string | null) ?? null, current: r.current === true,
    };
  }

  /** 단가표 전체 — 종류 → 과목 → 인원 → 최근순. 「살아 있는 줄」(`current`)은 서버가 판정한다 (D-R37) */
  async rateBook(today = todayKst()): Promise<RateBookDto> {
    const rates = (await this.inv.query(
      `${AccountingService.RATE_SELECT}
       ORDER BY k.sort NULLS LAST, k.name, sb.name NULLS FIRST, r.heads, r.from_date DESC, r.id DESC`, [today],
    )) as Array<Record<string, unknown>>;
    const stu = (await this.inv.query(
      `${AccountingService.STURATE_SELECT} ORDER BY st.name, su.student_id, su.kind_key NULLS FIRST, su.from_date DESC, su.id DESC`, [today],
    )) as Array<Record<string, unknown>>;
    return { rates: rates.map((r) => this.rateRow(r)), studentRates: stu.map((r) => this.studentRateRow(r)) };
  }

  /**
   * 기본 단가 한 줄 (C-38 「추가 수업 단가 등록」 · §54 RATE).
   * 종류·과목은 코드표에 있어야 하고(404), 같은 (종류·과목·인원·날짜)는 표의 `rate_tier_key` 가 막는다 → 409.
   * 인원 구간은 **줄마다** 둔다 — 「2인 45,000」을 넣어도 1인 줄은 그대로다 (D-R10 · N-17 ①).
   */
  async writeRate(userId: number, dto: RateWriteDto): Promise<RateRowDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [kind] = (await m.query(`SELECT key, name FROM kind WHERE key = $1`, [dto.kindKey])) as Array<{ key: string; name: string }>;
      if (!kind) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '그 종류가 코드표에 없습니다 — §18 프로그램에서 먼저 만듭니다' });
      const subKey = dto.subKey ?? null;
      if (subKey) {
        const [sub] = (await m.query(`SELECT key FROM sub WHERE key = $1`, [subKey])) as Array<{ key: string }>;
        if (!sub) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: '그 과목이 코드표에 없습니다' });
      }
      const [dup] = (await m.query(
        `SELECT id, unit_price FROM rate WHERE kind_key = $1 AND COALESCE(sub_key,'') = COALESCE($2,'') AND heads = $3 AND from_date = $4::date`,
        [dto.kindKey, subKey, dto.heads, dto.fromDate],
      )) as Array<{ id: string; unit_price: number }>;
      if (dup) {
        throw new ConflictException({
          code: 'RATE_DUPLICATE',
          message: `같은 종류·과목·인원에 ${dto.fromDate}부터의 단가(${won(Number(dup.unit_price))})가 이미 있습니다 — 바꾸려면 다른 날짜부터의 줄을 둡니다`,
        });
      }
      const [made] = (await m.query(
        `INSERT INTO rate (kind_key, sub_key, heads, unit_price, from_date) VALUES ($1,$2,$3,$4,$5::date) RETURNING id`,
        [dto.kindKey, subKey, dto.heads, dto.unitPrice, dto.fromDate],
      )) as Array<{ id: string }>;
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'RATE',$2,'create',$3::jsonb)`,
        [userId, Number(made.id), JSON.stringify({ kindKey: dto.kindKey, subKey, heads: dto.heads, unitPrice: dto.unitPrice, fromDate: dto.fromDate })],
      );
      const [row] = (await m.query(`${AccountingService.RATE_SELECT} WHERE r.id = $2`, [todayKst(), Number(made.id)])) as Array<Record<string, unknown>>;
      return this.rateRow(row);
    });
  }

  /**
   * 학생별 예외 한 줄 (H-81 「한 학생만 단가가 바뀐다 · 사유가 없으면 실패」).
   * 사유는 DTO 가 먼저 막고 표의 CHECK `sturate_reason_present` 가 마지막에 막는다 — 두 층 (원칙 26).
   * 다른 학생의 단가는 한 원도 안 바뀐다 — `invoice-lines` 가 `su.student_id = $1` 로만 읽는다.
   */
  async writeStudentRate(userId: number, dto: StudentRateWriteDto): Promise<StudentRateRowDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const [stu] = (await m.query(`SELECT id FROM stu WHERE id = $1`, [dto.studentId])) as Array<{ id: string }>;
      if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const kindKey = dto.kindKey ?? null;
      if (kindKey) {
        const [kind] = (await m.query(`SELECT key FROM kind WHERE key = $1`, [kindKey])) as Array<{ key: string }>;
        if (!kind) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '그 종류가 코드표에 없습니다' });
      }
      const reason = dto.reason.trim();
      if (!reason) throw new BadRequestException({ code: 'STURATE_REASON_REQUIRED', message: '학생별 예외에는 사유가 있어야 합니다 — 「형제 할인」·「장학」 처럼 적습니다' });
      const [dup] = (await m.query(
        `SELECT id FROM sturate WHERE student_id = $1 AND kind_key IS NOT DISTINCT FROM $2 AND from_date = $3::date`,
        [dto.studentId, kindKey, dto.fromDate],
      )) as Array<{ id: string }>;
      if (dup) {
        throw new ConflictException({ code: 'STURATE_DUPLICATE', message: `이 학생·종류에 ${dto.fromDate}부터의 예외가 이미 있습니다 — 다른 날짜부터의 줄을 둡니다` });
      }
      const [made] = (await m.query(
        `INSERT INTO sturate (student_id, kind_key, unit_price, from_date, reason, by_id) VALUES ($1,$2,$3,$4::date,$5,$6) RETURNING id`,
        [dto.studentId, kindKey, dto.unitPrice, dto.fromDate, reason, userId],
      )) as Array<{ id: string }>;
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'STURATE',$2,'create',$3::jsonb)`,
        [userId, Number(made.id), JSON.stringify({ studentId: dto.studentId, kindKey, unitPrice: dto.unitPrice, fromDate: dto.fromDate, reason })],
      );
      const [row] = (await m.query(`${AccountingService.STURATE_SELECT} WHERE su.id = $2`, [todayKst(), Number(made.id)])) as Array<Record<string, unknown>>;
      return this.studentRateRow(row);
    });
  }

  /**
   * 지출 등록 (H-83). **상태는 언제나 `pending`** — 올리는 사람이 금액을 확정할 수 없다(A-1 · A-5).
   * 영수증은 `file`(kind expense-receipt) 한 건을 가리키고, 한 파일은 한 지출에만 붙는다.
   * 대표(canMoney)에게 알림 한 건 — 심사는 그쪽 화면(`/accounting?tab=out`)에서 한다.
   */
  async createExpense(userId: number, dto: ExpenseCreateDto, canSeeAmounts: boolean): Promise<ExpenseDto> {
    return this.inv.manager.transaction(async (m: EntityManager) => {
      const requesterId = dto.requesterId ?? userId;
      const [who] = (await m.query(`SELECT id, name FROM staff WHERE id = $1 AND active`, [requesterId])) as Array<{ id: string; name: string }>;
      if (!who) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '그 직원을 찾을 수 없습니다' });
      let receiptUrl: string | null = null;
      if (dto.receiptFileId) {
        const [file] = (await m.query(`SELECT id, kind FROM file WHERE id = $1`, [dto.receiptFileId])) as Array<{ id: string; kind: string }>;
        if (!file) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '영수증 파일을 찾을 수 없습니다' });
        if (file.kind !== 'expense-receipt') {
          throw new BadRequestException({ code: 'EXPENSE_RECEIPT_KIND', message: '영수증은 expense-receipt 로 올린 파일이어야 합니다' });
        }
        receiptUrl = fileUrlOf(Number(file.id));
        const [used] = (await m.query(`SELECT id FROM expense WHERE receipt_url = $1`, [receiptUrl])) as Array<{ id: string }>;
        if (used) throw new ConflictException({ code: 'EXPENSE_RECEIPT_USED', message: `그 영수증은 이미 지출 #${used.id} 에 붙어 있습니다` });
      }
      const [made] = (await m.query(
        `INSERT INTO expense (spend_on, category, merchant, purpose, requested_amount, receipt_url, requester_id, state)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, 'pending') RETURNING id`,
        [dto.spendOn, dto.category, dto.merchant?.trim() || null, dto.purpose?.trim() || null, dto.requestedAmount, receiptUrl, requesterId],
      )) as Array<{ id: string }>;
      const id = Number(made.id);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'EXPENSE',$2,'create',$3::jsonb)`,
        [userId, id, JSON.stringify({ spendOn: dto.spendOn, category: dto.category, requestedAmount: dto.requestedAmount, requesterId, hasReceipt: receiptUrl !== null })],
      );
      // 심사할 사람에게 — 대표 전원. 올린 사람 자신이 대표면 자기에게는 보내지 않는다 (자기 심사는 막혀 있다 · A-5)
      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category)
         SELECT id, $1, $2, '/accounting?tab=out', 'request' FROM staff WHERE active AND role = 'ceo' AND id <> $1`,
        [userId, `지출 등록 — ${who.name} · ${EXPENSE_CATEGORY_LABEL[dto.category] ?? dto.category} · ${won(dto.requestedAmount)} (${dto.spendOn}) · 심사 대기`],
      );
      const [out] = (await m.query(`${EXPENSE_SELECT} WHERE e.id = $1`, [id])) as Array<Record<string, unknown>>;
      // 올린 사람에게는 자기가 적은 신청 금액이 돌아간다 — 확정 금액은 어차피 null(미심사)이다
      return this.expenseRow(out, canSeeAmounts || requesterId === userId);
    });
  }
}
