/** @file-guide
 * 목적: payout-sheet.ts — payoutSheet, lessonBonus, BONUS_*, TEACHER_OF_OCC, payoutSettleLabel (util)
 * 책임/재사용: 강사 한 사람 한 달의 정산 시트를 회차·리포트·시급·가산 규칙·확정 근거 줄에서 세는 한 곳. 강사 히스토리(§57 강사 화면)와 §56 시트 · 지급 확정이 같은 함수를 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사료 시트 — C94-b (테스트 시나리오 H-82 · O-148 · D-43) + W11 M2 (N-36 · N-51 · N-93).
 *
 * 규칙은 전부 `lib/rules` 한 곳이다 — 「리포트를 썼는가」(D-R7 · 승인 여부 무관) · 지각 차감(D-R32) · 원천징수(D-15).
 * 여기 있는 것은 그 규칙을 **한 달 한 강사의 회차에 적용해 더하는 일**뿐이다. 세는 것을 두 곳(강사 화면 · 대표 정산)이
 * 각자 하면 H-82 「미작성분이 포함되면 실패」가 한쪽에서만 지켜진다.
 *   · 휴강(canceled)은 세지 않는다 — 시수도 금액도 (H-82 「휴강이 잡히면 실패」)
 *   · 리포트 대상이 아닌 종류(`kind.rep = false` · 자습·회의 …)는 **쓴 것도 안 쓴 것도 아니다**(`na`) — 정산에 안 든다
 *   · 끝났는데 리포트를 안 쓴 회차는 **빠진다** — 얼마가 빠지는지(unwrittenAmount)를 함께 센다 (D-43)
 *   · 시급은 그 회차 날짜의 것(WAGE from_date) — 달 중간에 시급이 바뀌면 회차마다 다르다 (D8)
 *   · 수업 방식은 그날의 것 — 회차 예외(EXC.mode)가 있으면 그것 (`effectiveModeOf`)
 *
 * W11 M2 로 셋이 더해졌다 —
 *   ① **가산**(N-93) — `lessonBonus` 한 함수가 시트 · 확정 · 강사 히스토리에 같이 더한다. 규칙은 `payout_bonus_rule`
 *      (적용일 소급 없음 · 새 줄로만). D1 금액은 데이터가 아니다 — 대표가 적은 줄만 센다.
 *      **Kinder 는 0** 이다 — 수업을 Kinder 로 가를 표시가 모델에 없다(지어내지 않는다 · 규칙 줄은 적어 둘 수 있다).
 *   ② **확정된 달은 굳는다**(N-36 ①) — 확정한 달은 저장된 정산 행(payout)의 금액과 근거 줄(payout_line)을 그대로 읽는다.
 *      지금 시급 · 규칙으로 다시 세지 않는다. 근거 줄이 없는 옛 확정 달은 금액만 저장값이고 줄은 지금 계산이다.
 *   ③ **다음 달 보정**(N-51) — 확정된 달의 회차를 확정 뒤에 쓰면 그 달은 그대로 두고 **다음 미확정 달** 시트에
 *      「보정」 줄로 얹는다. 한 회차는 근거 줄에 한 번만 든다(표의 유일). 근거 줄이 없던 옛 확정 달은
 *      **리포트 제출 시각 > 확정 시각**인 회차만 보정 대상이다(저장된 시각 비교 · 추정 아님).
 */
import {
  REPORT_WRITTEN_DB, effectiveRepStateFromEnded, latePenalty, minutesSinceEnd, payoutConfirmed, tierFor, withholding,
  type SessionLike,
} from './rules';
import { effectiveModeOf, serStuOn, stuPausedOn } from './sql';

export interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

/** 회차의 담당 강사 — 회차 오버라이드가 있으면 그것, 없으면 규칙의 강사 (ser_occ.teacher_id ?? ser.teacher_id). */
export const TEACHER_OF_OCC = 'COALESCE(o.teacher_id, s.teacher_id)';

/* ══ 가산 규칙 (N-93 · D1 §4-12) ═══════════════════════════════════════════ */

/** 가산의 종류 셋 — 원문 §56 「추가로 드리는 돈」 세 칸 */
export const BONUS_KINDS = ['per_session', 'kinder_hourly', 'group_per_student'] as const;
export type BonusKind = (typeof BONUS_KINDS)[number];

/** 칸 이름과 도움말 — 원문 §56 컷의 낱말 그대로 (D-R18) */
export const BONUS_KIND_LABEL: Record<BonusKind, string> = {
  per_session: '한 번에',
  kinder_hourly: 'Kinder 수업',
  group_per_student: '그룹 학생 한 명 늘 때',
};
export const BONUS_KIND_HINT: Record<BonusKind, string> = {
  per_session: '한 번에 얼마',
  kinder_hourly: '시급에 더함',
  group_per_student: '한 명당',
};

/**
 * D1(§4-12)이 정한 금액 — **화면이 미리 채워 보여 줄 값**이지 데이터가 아니다(migration · 시드가 넣지 않는다).
 * 대표가 이 값으로 적으면 그 줄부터 센다. 「한 번에」는 원문 칸 이름 「모의수업 · 진단고사」의 두 종류다.
 */
export const BONUS_D1_DEFAULTS: ReadonlyArray<{ kind: BonusKind; kindKey: string | null; amount: number }> = [
  { kind: 'per_session', kindKey: 'mock', amount: 15000 },
  { kind: 'per_session', kindKey: 'diagx', amount: 15000 },
  { kind: 'kinder_hourly', kindKey: null, amount: 10000 },
  { kind: 'group_per_student', kindKey: null, amount: 5000 },
];

/** Kinder 수업을 가를 표시가 모델에 있는가 — 없다. 생기면 여기와 `lessonBonus` 의 한 갈래만 바뀐다 */
export const KINDER_MARKER_EXISTS = false;
export const KINDER_NOT_APPLIED = 'Kinder 수업을 가르는 표시가 아직 없어 0원으로 셉니다 — 규칙은 적어 둘 수 있습니다';

export interface BonusRuleRow { kind: BonusKind; kindKey: string | null; amount: number; fromDate: string }
export interface BonusPart { kind: BonusKind; amount: number }

/** 시급×분 — 항상 정수 절사. 60분 격자 밖 길이도 원 단위가 흔들리지 않게 한 번만 버린다. */
export const payOf = (rate: number, min: number): number => Math.floor((rate * min) / 60);

/** 한 칸(종류 · 수업 종류)에서 그 날짜에 걸린 줄 — 적용일이 그 날 이하인 마지막 줄 (시급 D8 과 같은 셈) */
function ruleAt(rules: readonly BonusRuleRow[], kind: BonusKind, kindKey: string | null, onDate: string): BonusRuleRow | null {
  let best: BonusRuleRow | null = null;
  for (const r of rules) {
    if (r.kind !== kind || r.kindKey !== kindKey || r.fromDate > onDate) continue;
    if (best === null || r.fromDate > best.fromDate) best = r;
  }
  return best;
}

/**
 * 한 회차의 가산 — **시트 · 확정 · 강사 히스토리가 부르는 한 함수** (N-93 · 「세는 곳이 둘이면 갈린다」 D-43).
 *   · 한 번에 — 그 수업 종류의 줄이 있으면 회차마다 그 금액
 *   · Kinder 시급에 더함 — 0 (표시 없음 · `KINDER_MARKER_EXISTS`)
 *   · 그룹 한 명당 — 그날 수업에 든 학생이 둘 이상이면 (금액 × 학생 수)를 시급처럼 시간에 곱한다
 *     (강사 덱 §32 「그룹 수업 2시간 · 학생당 +₩5,000 → ₩120,000」 = 2시간 × (45,000 + 3명 × 5,000))
 * 금액 0 인 줄은 「그 날부터 멈춤」이다.
 */
export function lessonBonus(
  l: { kindKey: string; onDate: string; durMin: number; bonusHeads: number },
  rules: readonly BonusRuleRow[],
): { total: number; parts: BonusPart[] } {
  const parts: BonusPart[] = [];
  const once = ruleAt(rules, 'per_session', l.kindKey, l.onDate);
  if (once && once.amount > 0) parts.push({ kind: 'per_session', amount: once.amount });
  if (KINDER_MARKER_EXISTS) {
    /* 표시가 생기면 여기서 `payOf(kinder.amount, l.durMin)` — 지금은 도달하지 않는다 */
  }
  const group = ruleAt(rules, 'group_per_student', null, l.onDate);
  if (group && group.amount > 0 && l.bonusHeads >= 2) {
    parts.push({ kind: 'group_per_student', amount: payOf(group.amount * l.bonusHeads, l.durMin) });
  }
  return { total: parts.reduce((n, p) => n + p.amount, 0), parts };
}

/** 가산 규칙 전부 — 적용일 차례. 시트 한 번에 한 번 읽는다 */
export async function loadBonusRules(q: Queryable): Promise<BonusRuleRow[]> {
  const rows = (await q.query(
    `SELECT kind, kind_key, amount, to_char(from_date,'YYYY-MM-DD') AS from_date
       FROM payout_bonus_rule ORDER BY from_date, id`,
  )) as Array<{ kind: string; kind_key: string | null; amount: number; from_date: string }>;
  return rows.map((r) => ({
    kind: r.kind as BonusKind, kindKey: r.kind_key ?? null, amount: Number(r.amount), fromDate: String(r.from_date),
  }));
}

/* ══ 시트 ═══════════════════════════════════════════════════════════════ */

/**
 * 정산 갈래 —
 *   written    이 달 정산에 드는 쓴 수업(확정된 달이면 근거 줄)
 *   correction 앞선 확정 달의 회차를 이 달에 얹은 보정 줄 (N-51)
 *   late       확정된 달의 회차인데 확정 뒤에 썼다 — 다음 미확정 달의 보정으로 간다(갔다)
 *   unwritten · canceled · na · upcoming — C94-b 그대로
 */
export type PayoutSettle = 'written' | 'correction' | 'late' | 'unwritten' | 'canceled' | 'na' | 'upcoming';
export const PAYOUT_SETTLES: readonly PayoutSettle[] = ['written', 'correction', 'late', 'unwritten', 'canceled', 'na', 'upcoming'];

const monthWord = (ym: string): string => `${Number(ym.slice(5, 7))}월`;

/** 갈래 이름 — 낱말은 서버가 만든다 (D-R18). 보정 · 넘어간 회차는 어느 달인지 함께 말한다 */
export function payoutSettleLabel(l: { settle: PayoutSettle; correctionOf: string | null; paidIn: string | null }): string {
  switch (l.settle) {
    case 'written': return '리포트 씀';
    case 'correction': return `보정 · ${monthWord(l.correctionOf ?? '')} 회차`;
    case 'late': return l.paidIn ? `확정된 달 — ${monthWord(l.paidIn)} 보정 지급` : '확정된 달 — 다음 달 보정';
    case 'unwritten': return '리포트 미작성';
    case 'canceled': return '휴강';
    case 'na': return '리포트 대상 아님';
    default: return '아직';
  }
}

export interface PayoutLesson {
  serId: number; onDate: string; startMin: number; durMin: number;
  kindKey: string; subKey: string | null; mode: 'offline' | 'online'; title: string | null;
  students: string | null; studentCount: number;
  repState: string; canceled: boolean; submittedAt: string | null;
  /** 시급×시간 — 쓴 수업 · 보정 줄만 */
  pay: number | null;
  lateCut: number | null;
  penaltyIfNow: number | null;
  /** 가산 합 — 쓴 수업 · 보정 줄만 (N-93) */
  bonus: number | null;
  bonusParts: BonusPart[];
  /** 그 회차에 쓴 시급 — 확정된 줄이면 스냅숏 */
  unitRate: number | null;
  settle: PayoutSettle;
  /** 보정 줄의 원래 달 'YYYY-MM' */
  correctionOf: string | null;
  /** 확정 뒤에 쓴 회차가 지급된 달 — 아직이면 null */
  paidIn: string | null;
  /** 값이 근거 줄(payout_line)에서 왔는가 */
  frozen: boolean;
}

/**
 * 강사 히스토리의 정산 종류별 근거 — 화면이 총액에서 역산하지 않도록
 * `payoutSheet` 회차의 기본 시급·가산 스냅숏을 서버가 합계한다. 기본 시급은 회차의 주된 종류
 * (진단·모의, Kinder, 그룹, 그 밖의 일반)에 싣고, 겹쳐 붙은 가산은 그 가산 종류에 싣는다.
 * 따라서 겹친 모의+그룹 회차도 빠뜨리거나 두 번 넣지 않으며 이 줄 합은 회차 근거의 gross와 같다.
 */
export const PAYOUT_BREAKDOWN_KEYS = ['general', 'kinder', 'group', 'diag', 'mock', 'other'] as const;
export type PayoutBreakdownKey = (typeof PAYOUT_BREAKDOWN_KEYS)[number];
export interface PayoutBreakdownLine {
  key: PayoutBreakdownKey;
  label: string;
  lessonCount: number;
  minutes: number;
  amount: number;
  note: string | null;
}

const BREAKDOWN_LABEL: Record<PayoutBreakdownKey, string> = {
  general: '일반 수업',
  kinder: 'Kinder 수업 가산',
  group: '그룹 수업 가산',
  diag: '진단고사 가산',
  mock: '모의수업 가산',
  other: '그 밖의 가산',
};

/** 일반·Kinder·그룹·진단·모의 종류별 합. 확정 회차는 `payout_line.bonus_detail` 스냅숏을 그대로 쓴다. */
export function payoutBreakdown(lessons: readonly PayoutLesson[]): PayoutBreakdownLine[] {
  const lines = new Map<PayoutBreakdownKey, PayoutBreakdownLine>(PAYOUT_BREAKDOWN_KEYS.map((key) => [key, {
    key,
    label: BREAKDOWN_LABEL[key],
    lessonCount: 0,
    minutes: 0,
    amount: 0,
    note: key === 'kinder' && !KINDER_MARKER_EXISTS ? KINDER_NOT_APPLIED : null,
  }]));
  for (const lesson of lessons) {
    if ((lesson.settle !== 'written' && lesson.settle !== 'correction') || lesson.pay === null) continue;
    const partKey = (part: BonusPart): PayoutBreakdownKey => part.kind === 'kinder_hourly'
      ? 'kinder'
      : part.kind === 'group_per_student'
        ? 'group'
        : lesson.kindKey === 'diagx'
          ? 'diag'
          : lesson.kindKey === 'mock'
            ? 'mock'
            : 'other';
    // 기본 시급은 종류가 겹쳐도 한 줄에만 둔다. 진단·모의 종류가 먼저고, 그 밖은 실제 가산 표시를 따른다.
    const primary: PayoutBreakdownKey = lesson.kindKey === 'diagx'
      ? 'diag'
      : lesson.kindKey === 'mock'
        ? 'mock'
        : lesson.bonusParts.some((part) => part.kind === 'kinder_hourly')
          ? 'kinder'
          : lesson.bonusParts.some((part) => part.kind === 'group_per_student')
            ? 'group'
            : 'general';
    const main = lines.get(primary)!;
    main.lessonCount += 1;
    main.minutes += lesson.durMin;
    main.amount += lesson.pay;

    const counted = new Set<PayoutBreakdownKey>([primary]);
    for (const part of lesson.bonusParts) {
      const key = partKey(part);
      const row = lines.get(key)!;
      row.amount += part.amount;
      if (!counted.has(key)) {
        row.lessonCount += 1;
        row.minutes += lesson.durMin;
        counted.add(key);
      }
    }
  }
  return PAYOUT_BREAKDOWN_KEYS.map((key) => {
    const row = lines.get(key)!;
    if (key === 'kinder' && row.amount !== 0) row.note = null;
    return row;
  });
}

export interface PayoutAgg {
  doneCount: number; doneMinutes: number;
  writtenCount: number; writtenMinutes: number;
  unwrittenCount: number; unwrittenMinutes: number; unwrittenAmount: number;
  remainingCount: number; remainingMinutes: number; remainingAmount: number;
  canceledCount: number;
  /** 리포트 대상이 아닌 종류의 회차 — 정산에 들지 않는다 */
  naCount: number;
  /** 가산을 포함한 총액 — 과세표준은 여기서 지각 차감을 뺀다 */
  gross: number; lateCut: number;
  /** 가산 합 (N-93) — gross 안에 들어 있다 */
  bonus: number;
  /** 시급이 없어 못 센 회차 — 0 이 아니면 시트가 완전하지 않다 */
  noRateCount: number;
  /** 이 달에 얹은 보정 줄 (N-51) — 쓴 수업과 따로 센다 */
  correctionCount: number; correctionMinutes: number;
  /** 이 달의 회차인데 확정 뒤에 써서 다음 달 보정으로 간 것 */
  lateCount: number;
}

export interface PayoutConfirmedInfo {
  payoutId: number;
  confirmedBy: number;
  confirmedAt: string;
  /** 근거 줄이 있는 확정인가 — 없으면 옛 확정(금액만 저장값) */
  lined: boolean;
}

export interface PayoutSheet {
  lessons: PayoutLesson[];
  agg: PayoutAgg;
  /** 과세표준 = gross − 지각 차감 · 세금은 `withholding` */
  base: number;
  incomeTax: number;
  localTax: number;
  net: number;
  /** 확정된 달이면 그 정산 — 금액은 저장값(굳은 값)이다 */
  confirmed: PayoutConfirmedInfo | null;
}

const SUBMITTED_KST = `to_char(r.submitted_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI')`;

/** 회차 한 줄의 공통 칸 — 이 달 회차 · 보정 후보 · 보정 줄이 같은 조각을 쓴다 */
const LESSON_COLUMNS = `
  o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(o.on_date,'YYYY-MM') AS on_month, o.canceled,
  (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
  (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
  s.kind_key, s.sub_key, ${effectiveModeOf('e', 's')} AS mode, s.title, k.rep AS reportable,
  r.state::text AS rep_state, ${SUBMITTED_KST} AS submitted_at,
  (SELECT string_agg(st.name, ', ' ORDER BY st.name)
     FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
    WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}) AS students,
  (SELECT COUNT(*)::int FROM ser_stu ss WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}) AS student_count,
  -- 그룹 가산의 머릿수 — 그날 수업에 든 학생(그날만 빠진 · 휴원 학생 제외 · 명단 가격과 같은 판정)
  (SELECT COUNT(*)::int FROM ser_stu ss
    WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
      AND NOT ${stuPausedOn('ss.student_id', 'o.on_date')}
      AND NOT EXISTS (SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id = e.id AND xo.student_id = ss.student_id)) AS bonus_heads,
  w.rate AS wage_rate`;

const LESSON_JOINS = `
  JOIN ser s      ON s.id = o.ser_id
  JOIN kind k     ON k.key = s.kind_key
  LEFT JOIN exc e ON e.ser_id = o.ser_id AND e.on_date = o.on_date
  LEFT JOIN LATERAL (
         SELECT rate FROM wage
          WHERE staff_id = $1 AND from_date <= o.on_date
          ORDER BY from_date DESC LIMIT 1
       ) w ON true`;

type Row = Record<string, unknown>;

/** 'YYYY-MM' 의 다음 달 */
export const nextMonth = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

/** 보정이 들어갈 달 — 원래 달 다음부터 **확정되지 않은 첫 달** (N-51 「다음 미확정 달」) */
export function correctionTargetMonth(fromMonth: string, confirmedMonths: ReadonlySet<string>): string {
  let m = nextMonth(fromMonth);
  // 확정된 달은 끝이 있다(달마다 한 줄) — 무한히 돌지 않는다
  for (let i = 0; i < 1200 && confirmedMonths.has(m); i++) m = nextMonth(m);
  return m;
}

export async function payoutSheet(
  q: Queryable, teacherId: number, month: string, today: string, nowMin: number,
): Promise<PayoutSheet> {
  const first = `${month}-01`;
  const written = new Set(REPORT_WRITTEN_DB as readonly string[]);
  const rules = await loadBonusRules(q);

  /* 이 달의 정산 행 — 확정됐는가 · 근거 줄이 있는가 */
  const [po] = (await q.query(
    `SELECT p.id, p.hours, p.gross, p.late_rep_cut, p.income_tax, p.local_tax, p.net, p.confirmed_by,
            to_char(p.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS confirmed_at_utc, p.confirmed_at,
            EXISTS (SELECT 1 FROM payout_line pl WHERE pl.payout_id = p.id) AS lined
       FROM payout p WHERE p.staff_id = $1 AND p.year_month = $2`,
    [teacherId, month],
  )) as Row[];
  const confirmed: PayoutConfirmedInfo | null = po && payoutConfirmed(po.confirmed_by as string | null)
    ? { payoutId: Number(po.id), confirmedBy: Number(po.confirmed_by), confirmedAt: String(po.confirmed_at_utc), lined: po.lined === true }
    : null;

  const rows = (await q.query(
    `SELECT ${LESSON_COLUMNS},
            (r.submitted_at > $3::timestamptz) AS after_confirm,
            pl.payout_id AS line_payout_id, pl.unit_rate AS line_rate, pl.amount AS line_amount, pl.cut AS line_cut,
            pl.bonus AS line_bonus, pl.bonus_detail AS line_bonus_detail, pl.correction AS line_correction,
            lp.year_month AS line_month
       FROM ser_occ o
       ${LESSON_JOINS}
       LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
       LEFT JOIN payout_line pl ON pl.ser_id = o.ser_id AND pl.on_date = o.on_date
       LEFT JOIN payout lp ON lp.id = pl.payout_id
      WHERE ${TEACHER_OF_OCC} = $1
        AND o.on_date >= $2::date
        AND o.on_date < $2::date + interval '1 month'
      ORDER BY o.on_date DESC, start_min`,
    [teacherId, first, confirmed ? (po.confirmed_at as Date) : null],
  )) as Row[];

  const lessons: PayoutLesson[] = [];
  const agg: PayoutAgg = {
    doneCount: 0, doneMinutes: 0, writtenCount: 0, writtenMinutes: 0,
    unwrittenCount: 0, unwrittenMinutes: 0, unwrittenAmount: 0,
    remainingCount: 0, remainingMinutes: 0, remainingAmount: 0,
    canceledCount: 0, naCount: 0, gross: 0, lateCut: 0, bonus: 0, noRateCount: 0,
    correctionCount: 0, correctionMinutes: 0, lateCount: 0,
  };

  const base = (r: Row) => {
    const onDate = String(r.on_date);
    const startMin = Number(r.start_min);
    const durMin = Number(r.dur_min);
    const canceled = Boolean(r.canceled);
    const submittedAt = (r.submitted_at as string) ?? null;
    const rate = r.wage_rate === null || r.wage_rate === undefined ? null : Number(r.wage_rate);
    const s: SessionLike = { date: onDate, startMin, durationMin: durMin, canceled, submittedAt };
    return {
      onDate, startMin, durMin, canceled, submittedAt, rate, s,
      lesson: {
        serId: Number(r.ser_id), onDate, startMin, durMin,
        kindKey: String(r.kind_key), subKey: (r.sub_key as string) ?? null,
        mode: (r.mode === 'online' ? 'online' : 'offline') as 'offline' | 'online',
        title: (r.title as string) ?? null,
        students: (r.students as string) ?? null,
        studentCount: Number(r.student_count ?? 0),
        canceled, submittedAt,
      },
      bonusHeads: Number(r.bonus_heads ?? 0),
    };
  };

  /** 지금 규칙으로 센 쓴 수업 한 줄의 돈 */
  const live = (b: ReturnType<typeof base>) => {
    if (b.rate === null) return null;
    const bonus = lessonBonus({ kindKey: b.lesson.kindKey, onDate: b.onDate, durMin: b.durMin, bonusHeads: b.bonusHeads }, rules);
    return { pay: payOf(b.rate, b.durMin), lateCut: latePenalty(b.s), bonus: bonus.total, parts: bonus.parts, unitRate: b.rate };
  };

  for (const r of rows) {
    const b = base(r);
    const ended = minutesSinceEnd(b.s, today, nowMin) > 0;
    // 리포트 상태는 규칙 한 곳이 정한다 — 대상 아닌 종류는 `na`, 대상인데 행이 없으면 끝났으면 `none` 아니면 `plan`
    const repState = effectiveRepStateFromEnded((r.rep_state as string | null) ?? null, r.reportable !== false, ended);
    const na = !b.canceled && repState === 'na';
    const isWritten = !b.canceled && !na && written.has(repState);
    const isUnwritten = !b.canceled && !na && ended && !isWritten;
    const lineHere = confirmed !== null && r.line_payout_id != null && Number(r.line_payout_id) === confirmed.payoutId;
    const lineElsewhere = r.line_payout_id != null && !lineHere;

    const out: PayoutLesson = {
      ...b.lesson, repState, pay: null, lateCut: null, penaltyIfNow: null, bonus: null, bonusParts: [], unitRate: b.rate,
      settle: 'upcoming', correctionOf: null, paidIn: null, frozen: false,
    };

    if (b.canceled) {
      agg.canceledCount += 1; out.settle = 'canceled';
    } else if (na) {
      agg.naCount += 1; out.settle = 'na';
    } else if (isWritten) {
      /*
       * 이 달 정산에 드는가 —
       *   확정된 달: 근거 줄이 이 정산에 있으면 든다(값은 줄) · 옛 확정(줄 없음)은 확정 전에 낸 것만 든다(값은 지금 계산)
       *   미확정 달: 다른 정산에 이미 든 회차가 아니면 든다
       * 들지 않으면 「확정된 달 — 다음 달 보정」(late)이다. 다른 정산에 들었으면 그 달을 말한다.
       */
      const paidHere = lineHere
        || (confirmed !== null && !confirmed.lined && r.line_payout_id == null && r.after_confirm !== true)
        || (confirmed === null && !lineElsewhere);
      if (paidHere) {
        out.settle = 'written';
        agg.writtenCount += 1; agg.writtenMinutes += b.durMin;
        if (lineHere) {
          out.pay = Number(r.line_amount); out.lateCut = Number(r.line_cut); out.bonus = Number(r.line_bonus);
          out.bonusParts = ((r.line_bonus_detail as BonusPart[] | null) ?? []).map((p) => ({ kind: p.kind, amount: Number(p.amount) }));
          out.unitRate = Number(r.line_rate); out.frozen = true;
        } else {
          const v = live(b);
          if (v) { out.pay = v.pay; out.lateCut = v.lateCut; out.bonus = v.bonus; out.bonusParts = v.parts; }
          else agg.noRateCount += 1;
        }
        if (out.pay !== null) { agg.gross += out.pay + (out.bonus ?? 0); agg.lateCut += out.lateCut ?? 0; agg.bonus += out.bonus ?? 0; }
      } else {
        out.settle = 'late';
        out.paidIn = lineElsewhere ? String(r.line_month) : null;
        agg.lateCount += 1;
      }
    } else if (isUnwritten) {
      const after = minutesSinceEnd(b.s, today, nowMin);
      out.penaltyIfNow = tierFor(after).amount;
      out.settle = 'unwritten';
      agg.unwrittenCount += 1; agg.unwrittenMinutes += b.durMin;
      const v = live(b);
      if (v) agg.unwrittenAmount += v.pay + v.bonus;
    } else if (!ended) {
      agg.remainingCount += 1; agg.remainingMinutes += b.durMin;
      const v = live(b);
      if (v) agg.remainingAmount += v.pay + v.bonus;
    }
    if (!b.canceled && !na && ended) { agg.doneCount += 1; agg.doneMinutes += b.durMin; }
    lessons.push(out);
  }

  /* ── 보정 줄 (N-51) ── */
  const corrections: PayoutLesson[] = [];
  if (confirmed) {
    // 확정된 달 — 이 정산에 얹혀 지급된 보정 줄(굳은 값)
    const lined = (await q.query(
      `SELECT ${LESSON_COLUMNS},
              pl.unit_rate AS line_rate, pl.amount AS line_amount, pl.cut AS line_cut,
              pl.bonus AS line_bonus, pl.bonus_detail AS line_bonus_detail
         FROM payout_line pl
         JOIN ser_occ o ON o.ser_id = pl.ser_id AND o.on_date = pl.on_date
         ${LESSON_JOINS}
         LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
        WHERE pl.payout_id = $2 AND pl.correction
        ORDER BY o.on_date DESC, start_min`,
      [teacherId, confirmed.payoutId],
    )) as Row[];
    for (const r of lined) {
      const b = base(r);
      corrections.push({
        ...b.lesson, repState: String(r.rep_state ?? 'none'), penaltyIfNow: null,
        pay: Number(r.line_amount), lateCut: Number(r.line_cut), bonus: Number(r.line_bonus),
        bonusParts: ((r.line_bonus_detail as BonusPart[] | null) ?? []).map((p) => ({ kind: p.kind, amount: Number(p.amount) })),
        unitRate: Number(r.line_rate), settle: 'correction', correctionOf: String(r.on_month), paidIn: null, frozen: true,
      });
    }
  } else {
    // 미확정 달 — 앞선 확정 달의 회차 중 확정 뒤에 쓴 것이 이 달로 오는가
    const confirmedMonths = new Set(((await q.query(
      `SELECT year_month FROM payout WHERE staff_id = $1 AND confirmed_by IS NOT NULL`, [teacherId],
    )) as Array<{ year_month: string }>).map((x) => String(x.year_month)));
    if (confirmedMonths.size > 0) {
      const cand = (await q.query(
        `SELECT ${LESSON_COLUMNS}
           FROM ser_occ o
           ${LESSON_JOINS}
           JOIN rep r     ON r.ser_id = o.ser_id AND r.on_date = o.on_date
           JOIN payout po ON po.staff_id = $1 AND po.year_month = to_char(o.on_date,'YYYY-MM') AND po.confirmed_by IS NOT NULL
          WHERE ${TEACHER_OF_OCC} = $1
            AND o.on_date < $2::date
            AND NOT o.canceled AND k.rep
            AND r.state::text = ANY($3::text[])
            AND NOT EXISTS (SELECT 1 FROM payout_line x WHERE x.ser_id = o.ser_id AND x.on_date = o.on_date)
            AND (EXISTS (SELECT 1 FROM payout_line x WHERE x.payout_id = po.id) OR r.submitted_at > po.confirmed_at)
          ORDER BY o.on_date DESC, start_min`,
        [teacherId, first, [...REPORT_WRITTEN_DB]],
      )) as Row[];
      for (const r of cand) {
        const fromMonth = String(r.on_month);
        if (correctionTargetMonth(fromMonth, confirmedMonths) !== month) continue;
        const b = base(r);
        const v = live(b);
        corrections.push({
          ...b.lesson, repState: String(r.rep_state), penaltyIfNow: null,
          pay: v?.pay ?? null, lateCut: v?.lateCut ?? null, bonus: v?.bonus ?? null, bonusParts: v?.parts ?? [],
          unitRate: b.rate, settle: 'correction', correctionOf: fromMonth, paidIn: null, frozen: false,
        });
      }
    }
  }
  for (const c of corrections) {
    agg.correctionCount += 1; agg.correctionMinutes += c.durMin;
    if (c.pay === null) { agg.noRateCount += 1; continue; }
    agg.gross += c.pay + (c.bonus ?? 0); agg.lateCut += c.lateCut ?? 0; agg.bonus += c.bonus ?? 0;
  }
  lessons.push(...corrections);

  if (confirmed && po) {
    // 확정된 달은 굳은 값 — 지금 계산이 달라도 저장된 정산이 정본이다(N-36 ① · 「확정한 달은 바뀌지 않는다」)
    const gross = Number(po.gross);
    const lateCut = Number(po.late_rep_cut);
    return {
      lessons, confirmed,
      agg: { ...agg, gross, lateCut, writtenMinutes: Math.round(Number(po.hours) * 60) - agg.correctionMinutes },
      base: gross - lateCut, incomeTax: Number(po.income_tax), localTax: Number(po.local_tax), net: Number(po.net),
    };
  }
  const taxBase = agg.gross - agg.lateCut;
  const tax = withholding(taxBase);
  return { lessons, agg, base: taxBase, incomeTax: tax.income, localTax: tax.local, net: taxBase - tax.total, confirmed: null };
}
