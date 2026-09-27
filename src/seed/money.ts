/** @file-guide
 * 목적: money.ts — INVOICES, INV_LINES, PAYMENTS, EXPENSES, PAYOUTS 등 (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 회계 — 청구서 · 입금 · 지출 · 정산.
 * 금액은 대표만 본다 (D-R39 canSeeProfit). 시드는 값만 넣고 가림은 API 가 한다.
 */
import { addD } from '../lib/recurrence';
import { addMonths } from '../lib/intake-words';
import { invoiceTitle } from '../modules/accounting/accounting.dto';
import { SEED_TODAY, SUBS } from './base';

const YM = SEED_TODAY.slice(0, 7);                        // 2026-08
const PREV = addD(SEED_TODAY, -31).slice(0, 7);           // 2026-07
const PREV2 = addD(SEED_TODAY, -62).slice(0, 7);          // 그 앞 달 — 확정분을 둘 자리

/** 청구서 — 학생별 한 장. 상태가 골고루 있어야 §52 보드가 채워진다 */
export const INVOICES = [
  { id: 1, studentId: 1,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 640000, state: 'sent',    issuedOn: addD(SEED_TODAY, -3), dueOn: addD(SEED_TODAY, 8),  paidAmount: 0 },
  { id: 2, studentId: 2,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 720000, state: 'sent',    issuedOn: addD(SEED_TODAY, -3), dueOn: addD(SEED_TODAY, 8),  paidAmount: 0 },
  { id: 3, studentId: 5,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 880000, state: 'sent',    issuedOn: addD(SEED_TODAY, -2), dueOn: addD(SEED_TODAY, 9),  paidAmount: 0 },
  { id: 4, studentId: 6,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 420000, state: 'paid',    issuedOn: addD(SEED_TODAY, -4), dueOn: addD(SEED_TODAY, 7),  paidAmount: 420000, paidAt: addD(SEED_TODAY, -2) },
  { id: 5, studentId: 7,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 380000, state: 'paid',    issuedOn: addD(SEED_TODAY, -4), dueOn: addD(SEED_TODAY, 7),  paidAmount: 380000, paidAt: addD(SEED_TODAY, -1) },
  { id: 6, studentId: 3,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 480000, state: 'draft',   issuedOn: null, dueOn: null, paidAmount: 0 },
  { id: 7, studentId: 4,  yearMonth: YM,   invType: 'tuition', title: invoiceTitle(YM, 'tuition'), amount: 360000, state: 'draft',   issuedOn: null, dueOn: null, paidAmount: 0 },
  { id: 8, studentId: 8,  yearMonth: PREV, invType: 'tuition', title: invoiceTitle(PREV, 'tuition'), amount: 640000, state: 'unpaid',  issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 0 },
  // 분납 표본 (A-D2) — 줄이 **두 개**다. 한 줄짜리만 있으면 누계 분기가 한 번도 안 돌아 본 적이 없게 된다
  { id: 9, studentId: 11, yearMonth: PREV, invType: 'tuition', title: invoiceTitle(PREV, 'tuition'), amount: 520000, state: 'partial', issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 320000, paidAt: null },
  { id: 10, studentId: 9, yearMonth: PREV, invType: 'tuition', title: invoiceTitle(PREV, 'tuition'), amount: 560000, state: 'paid',    issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 560000, paidAt: addD(SEED_TODAY, -8) },
];

/**
 * 줄 이름 — **제품의 줄 계산이 짓는 낱말 그대로**(과목 이름 · `invoice-lines.ts` 의 `label`) (53-04 · C54 이전 이름을 걷었다).
 * 과목 이름은 코드표(`SUBS`) 한 곳에서 읽는다 — 두 곳에 적으면 이름을 고치는 날 시드만 옛 이름으로 남는다.
 * 금액 · 횟수 · 단가는 그대로다(표본의 합계가 §52 머리 · 시험 기대값이다).
 */
const lineLabel = (subKey: string): string => SUBS.find((s) => s.key === subKey)?.name ?? subKey;

/** 청구서 줄 — 과목 · 횟수 · 단가 · 금액 (D-R37 입금 명세서) */
export const INV_LINES = [
  { invId: 1, subKey: 'ap-chem', label: lineLabel('ap-chem'), count: 8, unitPrice: 80000, seq: 1 },
  { invId: 2, subKey: 'sat-math', label: lineLabel('sat-math'),    count: 9, unitPrice: 80000, seq: 1 },
  { invId: 3, subKey: 'writing', label: lineLabel('writing'),      count: 6, unitPrice: 60000, seq: 1 },
  { invId: 3, subKey: 'admissions', label: lineLabel('admissions'),           count: 3, unitPrice: 180000, seq: 2 },
  { invId: 4, subKey: 'writing', label: lineLabel('writing'),      count: 7, unitPrice: 60000, seq: 1 },
  { invId: 5, subKey: 'map-math', label: lineLabel('map-math'),    count: 5, unitPrice: 60000, seq: 1 },
  { invId: 5, subKey: 'study-room', label: lineLabel('study-room'),             count: 4, unitPrice: 20000, seq: 2 },
  { invId: 6, subKey: 'map-math', label: lineLabel('map-math'),    count: 8, unitPrice: 60000, seq: 1 },
  { invId: 7, subKey: 'vocab',   label: lineLabel('vocab'),            count: 10, unitPrice: 35000, seq: 1 },
  { invId: 8, subKey: 'ap-chem', label: lineLabel('ap-chem'), count: 8, unitPrice: 80000, seq: 1 },
  { invId: 9, subKey: 'writing', label: lineLabel('writing'),      count: 7, unitPrice: 60000, seq: 1 },
  { invId: 10, subKey: 'vocab',  label: lineLabel('vocab'),            count: 16, unitPrice: 35000, seq: 1 },
];

/**
 * F12 「이월 막힘」 표본 (W11 · N-49 청크) — §54 이월이 **실제로 막히는 조건** 하나를 시드가 만든다.
 * 전에는 막힌 줄이 없어 칩이 「0 = 0」으로만 확인됐다(QA F12).
 *
 *   · 윤도현(7)은 이번 달 수업료를 완납했다 — 위 청구서 5(학습실 줄이 든다)
 *   · 이번 달 학습실(SER 10) 한 회차를 그날만 빠졌다 → 받아 놓고 못 해 준 수업 = 넘길 돈 (`seed/index` 가 날짜를 고른다)
 *   · 다음 달 수업료 청구서가 **이미 나가 있다** — 월말 일괄 발행이 만드는 초안(발행일 오늘)
 *   → 차감이 들어갈 청구서가 없어 서버가 이월을 막는다(`CARRY_NEXT_ISSUED` · 칩 「이월 막힘」).
 *
 * 다음 달 청구서의 줄 · 금액은 **적지 않는다** — 투영이 편 다음 달 회차를 제품의 줄 계산(`invoiceLines`)이 센 그대로 넣는다.
 * 기한은 이번 달 청구서들과 같은 간격(발행 뒤 11일)이다.
 */
export const CARRY_BLOCKED = {
  studentId: 7, paidInvId: 5, month: YM, serId: 10,
  nextInvId: 11, nextMonth: addMonths(YM, 1), issuedOn: SEED_TODAY, dueOn: addD(SEED_TODAY, 11),
} as const;

/** 입금 — 들어온 돈(§55) */
export const PAYMENTS = [
  { invId: 4,  studentId: 6,  amount: 420000, paidOn: addD(SEED_TODAY, -2), method: 'transfer', enteredBy: 2, confirmedBy: 2 },
  { invId: 5,  studentId: 7,  amount: 380000, paidOn: addD(SEED_TODAY, -1), method: 'transfer', enteredBy: 2, confirmedBy: 2 },
  { invId: 9,  studentId: 11, amount: 200000, paidOn: addD(SEED_TODAY, -20), method: 'transfer', enteredBy: 2, confirmedBy: 2, reason: '1회차 분납' },
  { invId: 9,  studentId: 11, amount: 120000, paidOn: addD(SEED_TODAY, -6),  method: 'cash',     enteredBy: 2, confirmedBy: 2, reason: '2회차 분납' },
  { invId: 10, studentId: 9,  amount: 560000, paidOn: addD(SEED_TODAY, -8), method: 'cash',     enteredBy: 2, confirmedBy: 2 },
];

/** 나간 돈(§56) — 분류는 간이 5분류+임대료(A-D5). 증빙 없는 한 건은 대기로 남는다 */
export const EXPENSES = [
  { spendOn: addD(SEED_TODAY, -23), category: 'rent',  merchant: '강남 임대',  purpose: '2층 강의실 8월 임대료', amount: 1400000, state: 'approved', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://tax/2026-08-2f' },
  { spendOn: addD(SEED_TODAY, -23), category: 'rent',  merchant: '강남 임대',  purpose: '3층 컨설팅룸 8월 임대료', amount: 800000, state: 'approved', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://tax/2026-08-3f' },
  { spendOn: addD(SEED_TODAY, -16), category: 'book',  merchant: '교재유통',  purpose: 'AP Chemistry 4th 20권 매입', amount: 480000, state: 'approved', requesterId: 4, reviewerId: 1, receiptUrl: 'seed://receipt/book-0812' },
  { spendOn: addD(SEED_TODAY, -27), category: 'etc',  merchant: 'Zoom',     purpose: 'Zoom Pro 6석 (월)', amount: 168000, state: 'approved', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://receipt/zoom-08' },
  // 대기 3건 — 분기마다 한 건씩 (AGENT §9 「시드에 값이 한 종류뿐」): 영수증 없음(A-4) · 정상 승인 가능 · 대표 본인 신청(A-5)
  { spendOn: addD(SEED_TODAY, -1),  category: 'supply', merchant: '오피스디포', purpose: '프린터 토너 · 소모품', requestedAmount: 92000, amount: null, state: 'pending', requesterId: 4, reviewerId: null, receiptUrl: null },
  { spendOn: addD(SEED_TODAY, -4),  category: 'ent',    merchant: '카페 서초',  purpose: '학부모 간담회 다과', requestedAmount: 145000, amount: null, state: 'pending', requesterId: 4, reviewerId: null, receiptUrl: 'seed://receipt/ent-0909' },
  { spendOn: addD(SEED_TODAY, -2),  category: 'fee',    merchant: '우체국',     purpose: '성적표 등기 발송 수수료', requestedAmount: 33000, amount: null, state: 'pending', requesterId: 1, reviewerId: null, receiptUrl: 'seed://receipt/fee-0910' },
];

/**
 * 강사료 정산 — 「리포트를 썼는가」 하나로 계산한다 (D-R7).
 * 차감은 수업 종료 시각 기준 분 단위 (D-R32). 여기 값은 지난달 확정분이다.
 */
export const PAYOUTS = [
  /*
   * 한 사람 한 달에 한 줄이다(`payout_staff_id_year_month_uniq`). 강사가 한 명이므로
   * **두 달**을 써야 `approved` 와 `draft` 두 갈래가 다 돈다 — 값이 한 종류뿐이면
   * 검증된 적 없는 것이다. 지난달은 아직 작성 중, 그 앞달은 확정분이다.
   *
   * gross = 시수 × 시급(WAGES: 김재훈 40,000). 두 사람의 정산을 합병하지 않는다.
   * 과세표준 = gross − 지각 차감, 소득세 3% · 지방세는 소득세의 10% (D-R32).
   */
  { staffId: 7, yearMonth: PREV2, hours: '42.0', gross: 1680000, lateRepCut: 15000, incomeTax: 49950, localTax: 4995, net: 1610055, state: 'approved', confirmedBy: 2 },
  { staffId: 7, yearMonth: PREV,  hours: '31.5', gross: 1260000, lateRepCut: 0,     incomeTax: 37800, localTax: 3780, net: 1218420, state: 'draft',    confirmedBy: null },
];

/**
 * 학생별 단가 예외 — 형제 할인 등.
 * C94-d(migration 1761000000000)부터 **새 행은 사유가 필수**다 (CHECK `sturate_reason_present` — NOT VALID 는 기존 행만 미룬다,
 * 시드는 언제나 새 INSERT 다 · C86-g). 누가 적었는지는 관리자(2).
 */
export const STURATES = [
  { studentId: 7,  kindKey: 'class', unitPrice: 54000, fromDate: '2026-04-06', reason: '형제 할인', byId: 2 },
  { studentId: 15, kindKey: 'class', unitPrice: 54000, fromDate: '2026-06-15', reason: '형제 할인', byId: 2 },
];
