/**
 * 회계 — 청구서 · 입금 · 지출 · 정산.
 * 금액은 대표만 본다 (D-R39 canSeeProfit). 시드는 값만 넣고 가림은 API 가 한다.
 */
import { addD } from '../lib/recurrence';
import { SEED_TODAY } from './base';

const YM = SEED_TODAY.slice(0, 7);                        // 2026-08
const PREV = addD(SEED_TODAY, -31).slice(0, 7);           // 2026-07

/** 청구서 — 학생별 한 장. 상태가 골고루 있어야 §52 보드가 채워진다 */
export const INVOICES = [
  { id: 1, studentId: 1,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 640000, state: 'sent',    issuedOn: addD(SEED_TODAY, -3), dueOn: addD(SEED_TODAY, 8),  paidAmount: 0 },
  { id: 2, studentId: 2,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 720000, state: 'sent',    issuedOn: addD(SEED_TODAY, -3), dueOn: addD(SEED_TODAY, 8),  paidAmount: 0 },
  { id: 3, studentId: 5,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 880000, state: 'sent',    issuedOn: addD(SEED_TODAY, -2), dueOn: addD(SEED_TODAY, 9),  paidAmount: 0 },
  { id: 4, studentId: 6,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 420000, state: 'paid',    issuedOn: addD(SEED_TODAY, -4), dueOn: addD(SEED_TODAY, 7),  paidAmount: 420000, paidAt: addD(SEED_TODAY, -2) },
  { id: 5, studentId: 7,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 380000, state: 'paid',    issuedOn: addD(SEED_TODAY, -4), dueOn: addD(SEED_TODAY, 7),  paidAmount: 380000, paidAt: addD(SEED_TODAY, -1) },
  { id: 6, studentId: 3,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 480000, state: 'draft',   issuedOn: null, dueOn: null, paidAmount: 0 },
  { id: 7, studentId: 4,  yearMonth: YM,   invType: 'tuition', title: '2026-09 수업료', amount: 360000, state: 'draft',   issuedOn: null, dueOn: null, paidAmount: 0 },
  { id: 8, studentId: 8,  yearMonth: PREV, invType: 'tuition', title: '2026-08 수업료', amount: 640000, state: 'unpaid',  issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 0 },
  { id: 9, studentId: 11, yearMonth: PREV, invType: 'tuition', title: '2026-08 수업료', amount: 520000, state: 'partial', issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 200000, paidAt: addD(SEED_TODAY, -20) },
  { id: 10, studentId: 9, yearMonth: PREV, invType: 'tuition', title: '2026-08 수업료', amount: 560000, state: 'paid',    issuedOn: addD(SEED_TODAY, -27), dueOn: addD(SEED_TODAY, -22), paidAmount: 560000, paidAt: addD(SEED_TODAY, -8) },
];

/** 청구서 줄 — 과목 · 횟수 · 단가 · 금액 (D-R37 입금 명세서) */
export const INV_LINES = [
  { invId: 1, subKey: 'ap-chem', label: '정규 1:1 · AP Chemistry', count: 8, unitPrice: 80000, seq: 1 },
  { invId: 2, subKey: 'sat-math', label: '정규 1:1 · SAT Math',    count: 9, unitPrice: 80000, seq: 1 },
  { invId: 3, subKey: 'writing', label: '정규 1:2 · Writing',      count: 6, unitPrice: 60000, seq: 1 },
  { invId: 3, subKey: 'admissions', label: '컨설팅 회차',           count: 3, unitPrice: 180000, seq: 2 },
  { invId: 4, subKey: 'writing', label: '정규 1:2 · Writing',      count: 7, unitPrice: 60000, seq: 1 },
  { invId: 5, subKey: 'map-math', label: '정규 1:2 · MAP Math',    count: 5, unitPrice: 60000, seq: 1 },
  { invId: 5, subKey: 'study-room', label: '자습 관리',             count: 4, unitPrice: 20000, seq: 2 },
  { invId: 6, subKey: 'map-math', label: '정규 1:2 · MAP Math',    count: 8, unitPrice: 60000, seq: 1 },
  { invId: 7, subKey: 'vocab',   label: '그룹 · Vocab',            count: 10, unitPrice: 35000, seq: 1 },
  { invId: 8, subKey: 'ap-chem', label: '정규 1:1 · AP Chemistry', count: 8, unitPrice: 80000, seq: 1 },
  { invId: 9, subKey: 'writing', label: '정규 1:2 · Writing',      count: 7, unitPrice: 60000, seq: 1 },
  { invId: 10, subKey: 'vocab',  label: '그룹 · Vocab',            count: 16, unitPrice: 35000, seq: 1 },
];

/** 입금 — 들어온 돈(§55) */
export const PAYMENTS = [
  { invId: 4,  studentId: 6,  amount: 420000, paidOn: addD(SEED_TODAY, -2), method: 'transfer', enteredBy: 2, confirmedBy: 2 },
  { invId: 5,  studentId: 7,  amount: 380000, paidOn: addD(SEED_TODAY, -1), method: 'transfer', enteredBy: 2, confirmedBy: 2 },
  { invId: 9,  studentId: 11, amount: 200000, paidOn: addD(SEED_TODAY, -20), method: 'transfer', enteredBy: 2, confirmedBy: 2 },
  { invId: 10, studentId: 9,  amount: 560000, paidOn: addD(SEED_TODAY, -8), method: 'cash',     enteredBy: 2, confirmedBy: 2 },
];

/** 나간 돈(§56) — 증빙 없는 한 건은 대기로 남는다 */
export const EXPENSES = [
  { spendOn: addD(SEED_TODAY, -23), category: 'rent',  merchant: '강남 임대',  purpose: '2층 강의실 8월 임대료', amount: 1400000, state: 'confirmed', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://tax/2026-08-2f' },
  { spendOn: addD(SEED_TODAY, -23), category: 'rent',  merchant: '강남 임대',  purpose: '3층 컨설팅룸 8월 임대료', amount: 800000, state: 'confirmed', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://tax/2026-08-3f' },
  { spendOn: addD(SEED_TODAY, -16), category: 'book',  merchant: '교재유통',  purpose: 'AP Chemistry 4th 20권 매입', amount: 480000, state: 'confirmed', requesterId: 4, reviewerId: 1, receiptUrl: 'seed://receipt/book-0812' },
  { spendOn: addD(SEED_TODAY, -27), category: 'misc',  merchant: 'Zoom',     purpose: 'Zoom Pro 6석 (월)', amount: 168000, state: 'confirmed', requesterId: 2, reviewerId: 1, receiptUrl: 'seed://receipt/zoom-08' },
  { spendOn: addD(SEED_TODAY, -1),  category: 'misc',  merchant: '오피스디포', purpose: '프린터 토너 · 소모품', requestedAmount: 92000, amount: null, state: 'pending', requesterId: 4, reviewerId: null, receiptUrl: null },
];

/**
 * 강사료 정산 — 「리포트를 썼는가」 하나로 계산한다 (D-R7).
 * 차감은 수업 종료 시각 기준 분 단위 (D-R32). 여기 값은 지난달 확정분이다.
 */
export const PAYOUTS = [
  { staffId: 6,  yearMonth: PREV, hours: '48.0', gross: 2016000, lateRepCut: 25000, incomeTax: 59730, localTax: 5973, net: 1925297, state: 'confirmed', confirmedBy: 2 },
  { staffId: 7,  yearMonth: PREV, hours: '42.0', gross: 1680000, lateRepCut: 15000, incomeTax: 49950, localTax: 4995, net: 1610055, state: 'confirmed', confirmedBy: 2 },
  { staffId: 8,  yearMonth: PREV, hours: '36.0', gross: 1368000, lateRepCut: 10000, incomeTax: 40740, localTax: 4074, net: 1313186, state: 'confirmed', confirmedBy: 2 },
  { staffId: 9,  yearMonth: PREV, hours: '31.5', gross: 1197000, lateRepCut: 0,     incomeTax: 35910, localTax: 3591, net: 1157499, state: 'draft',     confirmedBy: null },
  { staffId: 10, yearMonth: PREV, hours: '27.0', gross: 972000,  lateRepCut: 5000,  incomeTax: 29010, localTax: 2901, net: 935089,  state: 'draft',     confirmedBy: null },
  { staffId: 12, yearMonth: PREV, hours: '22.5', gross: 787500,  lateRepCut: 0,     incomeTax: 23625, localTax: 2362, net: 761513,  state: 'draft',     confirmedBy: null },
];

/** 학생별 단가 예외 — 형제 할인 등 */
export const STURATES = [
  { studentId: 7,  kindKey: 'class', unitPrice: 54000, fromDate: '2026-04-06' },
  { studentId: 15, kindKey: 'class', unitPrice: 54000, fromDate: '2026-06-15' },
];
