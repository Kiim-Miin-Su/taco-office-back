/**
 * 도메인 규칙 — 화면은 이 파일을 읽기만 하고 다시 계산하지 않는다.
 *
 * 정본: docs/spec/DEV-SPEC.md · 결정 원문: docs/decisions/DECISIONS-2026-08-27.md
 * (prototype/js/rules.js 를 그대로 옮긴 것이며, 테스트 56개가 함께 따라왔다.)
 *
 * 2026-08-27 대표 결정으로 바뀐 것
 *   D-R7   정산 조건    승인 → **작성했는가 하나**            ← countsForSettlement()
 *   D-R32  지각 차감    일수 구간 → **수업 종료 후 시간**      ← LATE_REPORT_TIERS
 *          1시간↑ 5,000원 · 4시간↑ 10,000원 · 그 위로 안 늘어난다
 *   D-R35  출결        보류 → **존치. 매니저 이상만 CRUD**    ← canEditAttendance()
 *   D-R39  권한        플래그 5개 저장 → **role 에서 3줄 파생** ← common/perm
 *
 * 그 전에 정해진 것
 *   D-15   원천징수는 소득세 3% + 지방소득세(소득세의 10%)를 **따로 계산해 각각 절사**한다.
 *          3.3% 를 한 번에 곱하면 화면 값과 1원이 어긋난다.
 *   D8     시급 변경은 즉시 발효하되 **그 이후 수업부터** 적용된다. 소급 없음.
 */

import type { IsoDate, Minutes } from './recurrence';
import { addD, diffD } from './recurrence';

/* ── 회차 ─────────────────────────────────────────────────────────────── */

/** 정산·리포트 판정에 필요한 최소 정보. 엔티티 전체를 받지 않는다. */
export interface SessionLike {
  /** 수업 날짜 */
  date: IsoDate;
  /** 시작 시각 (분) */
  startMin: Minutes;
  /** 길이 (분) */
  durationMin: number;
  canceled?: boolean;
  /** 리포트 상태 */
  report?: ReportState;
  /** 최초 제출 시각 'YYYY-MM-DD HH:mm'. 재제출은 이 값을 바꾸지 않는다. */
  submittedAt?: string | null;
}

export type ReportState = 'na' | 'plan' | 'none' | 'draft' | 'submitted' | 'approved' | 'rejected';

export const endMin = (s: SessionLike): Minutes => s.startMin + s.durationMin;
export const isCanceled = (s: SessionLike): boolean => !!s.canceled;

/** 지금(today, nowMin) 기준으로 이미 끝난 회차인가 */
export function isPast(s: SessionLike, today: IsoDate, nowMin: Minutes): boolean {
  return s.date < today || (s.date === today && endMin(s) <= nowMin);
}

/* ══ 정산 조건 — 불변식 I-2 ═══════════════════════════════════════════
   2026-08-27 대표 결정 1번 (D-R7):
     "강사료는 리포트 작성 후 바로 지급 (반려, 최초 승인, 재승인 급여 차감 없음)"

   → 조건은 **「리포트를 썼는가」 하나**다. 승인 여부를 보지 않는다.
     반려되어 다시 쓰거나 승인이 늦어져도 급여가 깎이지 않는다.
     깎이는 것은 **지각 제출뿐**이다 (LATE_REPORT_TIERS).

   화면 코드에서 report 상태를 직접 비교하지 않는다. 이 조건은 이미 두 번 바뀌었고
   (출결 확정 → 리포트 승인 → 리포트 작성), 다음에 또 바뀔 때 고칠 곳이 한 줄이어야 한다. */

/** 「썼다」로 인정하는 상태 — 제출한 순간부터다 */
export const REPORT_WRITTEN: ReportState[] = ['submitted', 'approved', 'rejected'];

export const hasReport = (s: SessionLike): boolean =>
  !!s.report && REPORT_WRITTEN.includes(s.report);

export const countsForSettlement = (s: SessionLike): boolean => !isCanceled(s) && hasReport(s);

/* ══ 리포트 기한 ═════════════════════════════════════════════════════
   차단이 아니라 **독촉**이다. 늦어도 쓸 수 있고, 쓰면 정산에 들어간다 (D-R7).
   ⚠️ 2026-08-27 결정 이후 이 기한은 **정산 제외 사유가 아니다.**
      깎이는 것은 수업 종료 후 시간으로만 정해진다 (D-R32).
      이 값은 「아직 안 쓴 회차」를 독촉 목록에 올리는 기준으로만 쓴다. */
export const REPORT_DEADLINE_DAYS = 10;

export const deadlineOf = (s: SessionLike): IsoDate => addD(s.date, REPORT_DEADLINE_DAYS);
export const daysLeft = (s: SessionLike, today: IsoDate): number => diffD(deadlineOf(s), today);

/** 기한 자체가 지났는가 — 리포트를 썼는지는 보지 않는다 */
export function isPastDeadline(s: SessionLike, today: IsoDate, nowMin: Minutes): boolean {
  return !isCanceled(s) && isPast(s, today, nowMin) && daysLeft(s, today) < 0;
}

/**
 * 독촉 목록에 오르는가 = **안 쓴 채로 기한이 지났다.**
 *
 * ⚠️ 프로토타입에서는 `!countsForSettlement(s) && isOverdue(s)` 처럼 호출부마다 두 조건을
 *    조합했다. 한 곳만 빠뜨려도 이미 쓴 회차가 「미제출」로 뜬다 — 강사에게는 사고다.
 *    조건을 여기 하나로 합친다 (AGENT.md 원칙 16 · 판정은 한 곳에서).
 */
export function isOverdue(s: SessionLike, today: IsoDate, nowMin: Minutes): boolean {
  return isPastDeadline(s, today, nowMin) && !hasReport(s);
}

/* ══ 리포트 지각 제출 차감 (D-R32) ═══════════════════════════════════
   원문: "리포트 지각 제출시 1시간 이상은 5,000원 차감 → 4시간 이상 10,000원 차감
          (자동 회계 정산 및 급여 시수에 반영)"

   ⚠️ 기준이 **날짜에서 시각으로** 바뀌었다.
      v26: 수업일 + N일   →   확정: **수업 종료 시각 + N분**
   두 구간뿐이고, 4시간을 넘어도 10,000원에서 더 늘지 않는다.
   구간을 바꿀 일이 생기면 이 배열 하나만 고친다.                        */

export interface LateTier {
  /** 수업 종료 후 이 분(分)을 넘으면 */
  fromMinutes: number;
  amount: number;
  short: string;
  say: string;
  tone: 'ok' | 'warn' | 'bad';
}

export const LATE_REPORT_TIERS: LateTier[] = [
  { fromMinutes: 240, amount: 10000, short: '4시간 이상', say: '− 10,000원', tone: 'bad' },
  { fromMinutes: 60, amount: 5000, short: '1시간 이상', say: '−  5,000원', tone: 'warn' },
  { fromMinutes: 0, amount: 0, short: '1시간 이내', say: '차감 없음', tone: 'ok' },
];

/** 화면에 뿌리는 표는 읽기 쉬운 순서(작은 것부터) — 판정은 위 배열이 한다 */
export const PENALTY_RULE: LateTier[] = [...LATE_REPORT_TIERS].reverse();

/** 수업이 끝나고 몇 분 지났을 때 얼마인가 — 위에서부터 처음 걸리는 것 */
export function tierFor(minutesAfter: number): LateTier {
  for (const t of LATE_REPORT_TIERS) if (minutesAfter >= t.fromMinutes) return t;
  return LATE_REPORT_TIERS[LATE_REPORT_TIERS.length - 1]!;
}

/** 수업 종료 → 그 시각까지 몇 분인가. 날짜가 다르면 하루 1440분으로 더한다 */
export function minutesSinceEnd(s: SessionLike, atDate: IsoDate, atMin: Minutes): number {
  return diffD(atDate, s.date) * 1440 + (atMin - endMin(s));
}

const HHMM = /^(\d{2}):(\d{2})$/;

/** 'HH:mm' → 분. 형식이 아니면 0 */
export function toMin(hhmm: string): Minutes {
  const m = HHMM.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 분 → 'HH:mm' */
export function fromMin(min: Minutes): string {
  const h = Math.floor(min / 60);
  return `${String(h).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * 제출이 끝난 회차의 확정 차감액 — 기준은 **최초 제출**이다.
 * 반려 후 재제출은 다시 재지 않는다 (D-R7: 재승인으로 깎이지 않는다).
 */
export function latePenalty(s: SessionLike): number {
  if (isCanceled(s) || !s.submittedAt) return 0;
  const at = String(s.submittedAt);
  const d = at.slice(0, 10);
  const hm = at.length >= 16 ? toMin(at.slice(11, 16)) : 0; // 'YYYY-MM-DD HH:mm'
  const after = minutesSinceEnd(s, d, hm);
  return after <= 0 ? 0 : tierFor(after).amount;
}

export interface PenaltyNow {
  amount: number;
  /** 「정산 제외」는 더 이상 없다 — 늦어도 쓰면 들어간다 (D-R7) */
  over: false;
  left: number;
  after: number;
  head: string;
  next: number | null;
  nextIn: number | null;
  nextSay: string | null;
}

/** "2시간 15분" 처럼 읽어 준다 */
export function sinceText(min: number): string {
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;

/** 지금 제출하면 얼마가 깎이는지 — 리포트 화면이 실시간으로 읽는다 */
export function penaltyNow(s: SessionLike, today: IsoDate, nowMin: Minutes): PenaltyNow {
  const after = minutesSinceEnd(s, today, nowMin);
  const last = LATE_REPORT_TIERS[LATE_REPORT_TIERS.length - 1]!;
  const t = after <= 0 ? last : tierFor(after);
  const left = daysLeft(s, today);

  /* 아직 수업이 끝나지 않았다 */
  if (after <= 0) {
    return {
      amount: 0,
      over: false,
      left,
      after,
      head: '수업이 끝나면 바로 쓸 수 있습니다 · 1시간 안에 내면 차감이 없습니다',
      next: 5000,
      nextIn: 60,
      nextSay: '수업 종료 후 1시간이 지나면',
    };
  }
  /* 다음 구간까지 몇 분 남았나 — fromMinutes 가 지금보다 큰 것 중 가장 가까운 것 */
  const upper = [...LATE_REPORT_TIERS].reverse().find((x) => x.fromMinutes > after);
  return {
    amount: t.amount,
    over: false,
    left,
    after,
    head: t.amount
      ? `지금 제출하면 ${won(t.amount)}이 깎입니다 · 수업이 끝난 지 ${sinceText(after)}`
      : `지금 제출하면 차감이 없습니다 · 수업이 끝난 지 ${sinceText(after)}`,
    next: upper ? upper.amount : null,
    nextIn: upper ? upper.fromMinutes - after : null,
    nextSay: upper ? `${Math.ceil(((upper.fromMinutes - after) / 60) * 10) / 10}시간 더 지나면` : null,
  };
}

/* ══ 출결 (D-R35) ═════════════════════════════════════════════════════
   2026-08-27 대표 결정 6번:
     "오늘 및 이전 스케줄에 대한 출결 사항은 매니저 이상만 CRUD 가능"

   강사에게 열어 두는 것은 **당일 최초 체크 딱 한 번**뿐이다.
   지난 회차는 최초 체크조차 강사가 못 한다 — 매니저가 대신 찍는다.
   화면 코드에서 역할을 직접 비교하지 않는다. 판정은 여기 한 곳이다.      */

export type AttendanceMode = 'readonly' | 'first' | 'manage';

export interface AttendanceCtx {
  /** 이미 찍힌 출결 */
  att?: { by: string; at: string; result: 'completed' | 'canceled' } | null;
  /** 매니저가 대신 처리한 흔적 */
  statusChanged?: { by: string; at: string } | null;
}

export function canEditAttendance(
  s: SessionLike & AttendanceCtx,
  opts: { isTeacher: boolean; today: IsoDate; nowMin: Minutes },
): AttendanceMode {
  const { isTeacher, today, nowMin } = opts;
  if (!isTeacher) return 'manage'; // 매니저 이상은 언제든 정정 (canCrudAll)
  if (isCanceled(s)) return 'readonly'; // 관리자 취소분은 손대지 않는다
  if (!isPast(s, today, nowMin)) return 'readonly'; // 아직 안 끝났다 — 출결이 없다
  if (s.date !== today) return 'readonly'; // ← 지난 회차는 매니저만 (D-R35)
  if (s.att || s.statusChanged) return 'readonly'; // 이미 한 번 찍혔다
  return 'first'; // 오늘, 지금, 딱 한 번
}

export interface FirstCheckResult {
  ok: boolean;
  msg: string;
}

/** 강사의 최초 체크. 거절 사유가 상황마다 다르다 — "안 됩니다"로 뭉치지 않는다. */
export function firstCheck(
  s: SessionLike & AttendanceCtx,
  result: 'completed' | 'canceled',
  opts: { isTeacher: boolean; today: IsoDate; nowMin: Minutes },
): FirstCheckResult {
  const can = canEditAttendance(s, opts);
  if (can === 'readonly') {
    if (!isPast(s, opts.today, opts.nowMin))
      return { ok: false, msg: '수업이 끝난 뒤에 체크할 수 있습니다' };
    if (s.date !== opts.today) return { ok: false, msg: '지난 수업의 출결은 매니저가 처리합니다' };
    return { ok: false, msg: '이미 체크된 출결입니다 — 정정은 매니저에게 요청하세요' };
  }
  if (can === 'manage') return { ok: false, msg: '매니저 정정 경로로 처리하세요' };
  return {
    ok: true,
    msg: result === 'completed' ? '출결을 완료로 확정했습니다' : '출결을 취소로 확정했습니다',
  };
}

/* ══ 원천징수 (D-15) ══════════════════════════════════════════════════
   3.3% 를 한 번에 곱하지 않는다 — 신고가 두 항목으로 나뉘므로 계산도 나뉜다.
   각각 **원 단위로 버린다.** 합쳐서 버리면 화면 값과 1원이 어긋난다.      */

export interface Withholding {
  income: number;
  local: number;
  total: number;
}

export function withholding(gross: number): Withholding {
  const income = Math.floor(gross * 0.03); // 소득세 3%
  const local = Math.floor(income * 0.1); // 지방소득세 = 소득세의 10%
  return { income, local, total: income + local };
}

/* ══ 시급 이력 (D8) ═══════════════════════════════════════════════════
   변경은 즉시 발효하되 **그 이후 수업부터** 적용된다. 소급 없음.
   기준은 수업일이지 정산월이 아니므로, 월중 변경이면 한 달 안에서 두 단가가 섞인다. */

export interface RateHistoryEntry {
  from: IsoDate;
  rate: number;
}

/** 그 수업일에 유효한 시급. 이력이 정정돼도 지난 정산은 흔들리지 않는다 (불변식 I-8). */
export function rateAt(history: RateHistoryEntry[], onDate: IsoDate): number {
  let hit = 0;
  for (const h of [...history].sort((a, b) => a.from.localeCompare(b.from))) {
    if (h.from <= onDate) hit = h.rate;
  }
  return hit;
}
