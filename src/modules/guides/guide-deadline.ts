/** @file-guide
 * 목적: guide-deadline.ts — GUIDE_LADDER, guideDeadline, guideLeftLabel (util)
 * 책임/재사용: §43 안내 기한(N-89)의 판정 한 곳 — 남은 시간 문장 · 사다리 칸 · 긴급도를 서버가 만든다. 화면은 받은 값만 그린다(D-R37).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { isIsoDate, kstMidnightMs, minutesUntil } from '../../lib/kst';

/**
 * N-89 채택(W11 · 2026-09-26) — **안내 기한 = 그 안내가 걸린 첫 수업의 시작 시각**(`ser_occ.span` 하한).
 * 회차가 없으면(옛 안내 · 옮겨져 사라진 회차) 기한 날(`due_on`)의 00:00 KST.
 *
 * 원문 §43 「한 번」 줄의 사다리 머리 「하루 · 6시간 · 3시간」 — 지난 칸은 ✕, 남은 칸은 이름 그대로다.
 * 원문의 두 줄이 기준을 보여 준다: 5시간 남은 줄은 하루·6시간이 ✕ 이고 상태가 「마감 지남」(붉은 테),
 * 23시간 남은 줄은 하루만 ✕ 이고 상태가 「오늘 안에」다. 그래서 **마감은 6시간 칸**이다(머리 「마감 초과」 칸이 이 수를 센다).
 *
 * 낱말(칸 이름 · 상태 이름)은 원문 그대로이고 새로 짓지 않는다. 「N일 남음 / N일 지남」은 하루 밖의 줄을 같은 문장 틀로 적은 것이다.
 */
export const GUIDE_LADDER = [
  { key: 'day', label: '하루', beforeMin: 24 * 60 },
  { key: 'h6', label: '6시간', beforeMin: 6 * 60 },
  { key: 'h3', label: '3시간', beforeMin: 3 * 60 },
] as const;

/** 마감 = 6시간 칸이 지났다(원문 「마감 지남」) · 하루 칸만 지났다 = 「오늘 안에」 */
const DUE_MIN = 6 * 60;
const TODAY_MIN = 24 * 60;

export type GuideUrgency = 'overdue' | 'today' | 'none';
export const GUIDE_URGENCY_LABEL: Readonly<Record<GuideUrgency, string | null>> = {
  overdue: '마감 지남',
  today: '오늘 안에',
  none: null,
};

export interface GuideLadderStep { key: string; label: string; passed: boolean }

export interface GuideDeadline {
  /** 기준 시각(ISO · +09:00) — 수업 시작, 없으면 기한 날 00:00 */
  startAt: string;
  basis: 'lesson' | 'due';
  /** 남은 분 — 지났으면 음수(내림) */
  minutesLeft: number;
  /** 「5시간 남음」 · 「40분 남음」 · 「3일 지남」 */
  leftLabel: string;
  ladder: GuideLadderStep[];
  urgency: GuideUrgency;
  urgencyLabel: string | null;
}

/** 남은(지난) 분을 원문 문장 틀로 — 한 시간 안은 분, 이틀 안은 시간, 그 밖은 날. 내림이다(5시간 59분 → 5시간). */
export function guideLeftLabel(minutesLeft: number): string {
  const past = minutesLeft < 0;
  const m = Math.abs(minutesLeft);
  const tail = past ? '지남' : '남음';
  if (m < 60) return `${m}분 ${tail}`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}시간 ${tail}`;
  return `${Math.floor(m / (24 * 60))}일 ${tail}`;
}

/**
 * 안내 하나의 기한 — `lessonStartAt`(회차 시작 ISO)이 있으면 그것, 없으면 `dueOn` 00:00 KST. 둘 다 없으면 null(기한을 짓지 않는다).
 * `now` 는 시험이 고정한다.
 */
export function guideDeadline(
  lessonStartAt: string | null | undefined,
  dueOn: string | null | undefined,
  now: number = Date.now(),
): GuideDeadline | null {
  let atMs = Number.NaN;
  let basis: GuideDeadline['basis'] = 'lesson';
  let startAt = '';
  if (lessonStartAt) {
    atMs = Date.parse(lessonStartAt);
    startAt = lessonStartAt;
  }
  if (!Number.isFinite(atMs) && dueOn && isIsoDate(dueOn)) {
    atMs = kstMidnightMs(dueOn);
    basis = 'due';
    startAt = `${dueOn}T00:00:00+09:00`;
  }
  if (!Number.isFinite(atMs)) return null;
  const minutesLeft = minutesUntil(atMs, now);
  const urgency: GuideUrgency = minutesLeft <= DUE_MIN ? 'overdue' : minutesLeft <= TODAY_MIN ? 'today' : 'none';
  return {
    startAt,
    basis,
    minutesLeft,
    leftLabel: guideLeftLabel(minutesLeft),
    ladder: GUIDE_LADDER.map((step) => ({ key: step.key, label: step.label, passed: minutesLeft <= step.beforeMin })),
    urgency,
    urgencyLabel: GUIDE_URGENCY_LABEL[urgency],
  };
}
