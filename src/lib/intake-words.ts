/** @file-guide
 * 목적: intake-words.ts — INTAKE_STAGES, IntakeStage, INTAKE_STAGE_LABEL, intakeStageLabel (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { daysUntil } from './kst';
import { parseRule, ruleLabel } from './recurrence';

/**
 * 상담 단계 여섯 — **낱말과 순서가 사는 단 하나의 자리** (원본 §23).
 *
 * 컷의 퍼널은 `1차 상담 › 2차 대기 › 2차 상담 › 보류 ⇒ 등록 | 등록 실패` 로 읽힌다.
 * 화살표가 `›` 에서 **`⇒` 로 바뀌는 자리**에 뜻이 있다 — 앞 넷은 **아직 깔때기 안**이고
 * 뒤 둘은 **끝난 결과**다. 그래서 `funnel` 이 단계마다 붙는다.
 *
 * 여섯째 칸의 이름은 「실패」가 아니라 **「등록 실패」**다 (컷 §23 의 여섯째 레인 머리).
 * 화면이 제 표를 들면 보드 머리와 퍼널이 다른 낱말을 쓰게 된다 (D-R18).
 */
export const INTAKE_STAGES = ['first', 'wait2nd', 'second', 'hold', 'enrolled', 'failed'] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];

export const INTAKE_STAGE_LABEL: Record<IntakeStage, string> = {
  first: '1차 상담',
  wait2nd: '2차 대기',
  second: '2차 상담',
  hold: '보류',
  enrolled: '등록',
  failed: '등록 실패',
};

/**
 * 칸 이름 아래 한 줄 — 원본 §23 의 칸마다 있다.
 * **무엇인지가 아니라 다음에 무엇을 하는지**를 적는다: 「2차 일정 + 진단고사 잡기」.
 * (원본 §23 의 칸에는 §26·§61·§67 과 달리 **번호가 없다** — 설명 줄만 있다.)
 */
export const INTAKE_STAGE_SUB: Record<IntakeStage, string> = {
  first: '2차 일정 + 진단고사 잡기',
  wait2nd: '예정일에 2차 상담 진행',
  second: '보류 · 등록 · 등록 실패 중 선택',
  hold: 'D+2에 수락 여부 확인',
  enrolled: '해피콜 → 월간 상담',
  failed: '사유 기록',
};

/** 아직 깔때기 안인 단계 — 등록·등록 실패는 결과라 빠진다 */
export const INTAKE_FUNNEL_STAGES: readonly IntakeStage[] = ['first', 'wait2nd', 'second', 'hold'];

export const intakeStageLabel = (stage: string): string =>
  INTAKE_STAGE_LABEL[stage as IntakeStage] ?? stage;

export const isIntakeFunnel = (stage: string): boolean =>
  (INTAKE_FUNNEL_STAGES as readonly string[]).includes(stage);

/**
 * 중단 지점 네 어휘 — **낱말과 순서가 사는 단 하나의 자리** (원본 §24 · N-25 채택 §4-17 · C35).
 *
 * 이 넷은 **저장된 값**이다(`LEAD.stop_at`). 컷 §24 는 「1차 상담 중단 · 2차 안 옴 ·
 * 2차 상담 중단 · 보류 후 무산」으로, 컷 §71 은 「1차 중단 · 2차 안 옴 · 배치 중단 ·
 * 보류 무산」으로 적어 **두 컷이 서로 다르게 쓰고 우리 넷과도 집합이 다르다**.
 * 이름만 갈아 끼우면 **이미 분류된 행이 다른 뜻으로 읽힌다** — 그래서 되돌리지 않고
 * [CUT-VS-PRODUCT](../../../docs/report/CUT-VS-PRODUCT-2026-09-13.md) 에 남겨 둔 것이다.
 * 여기서 하는 일은 **낱말을 옮기는 것**뿐이고 바꾸는 것이 아니다.
 *
 * 순서는 깔때기 순이다 — 실패 지정 select 도 「어디서 놓쳤나」 표도 이 순서를 쓴다 (D-R25).
 */
export const INTAKE_STOPS = ['before_book', 'before_first', 'after_first', 'after_second'] as const;
export type IntakeStop = (typeof INTAKE_STOPS)[number];

export const INTAKE_STOP_LABEL: Record<IntakeStop, string> = {
  before_book: '상담 예약 전 이탈',
  before_first: '1차 상담 전 이탈',
  after_first: '1차 후 미진행',
  after_second: '2차 후 미등록',
};

/**
 * 분류되지 않은 실패 — 레거시 건은 **추정 이관 없이 미분류로 둔다** (N-25).
 * 이 줄이 없으면 「등록 실패 N건」 머리와 줄들의 합이 갈린다 (N-19).
 */
export const INTAKE_STOP_UNSET = 'none';
export const INTAKE_STOP_UNSET_LABEL = '분류 안 됨';

export const intakeStopLabel = (stop: string | null | undefined): string =>
  stop == null || stop === INTAKE_STOP_UNSET
    ? INTAKE_STOP_UNSET_LABEL
    : (INTAKE_STOP_LABEL[stop as IntakeStop] ?? stop);

/* ══ 유입 경로 · 접촉 원장 · 단계 전이표 (C90 · N-44 · N-45) ═══════════════════════ */

/**
 * 유입 경로 여섯 — **낱말과 순서가 사는 단 하나의 자리** (컷 §23 의 유입 칩 줄 · N-44 결정문 그대로).
 * 저장값은 `LEAD.source`(`lead_source_words` CHECK · NULL 허용) — **옛 건은 NULL** 이고 추정하지 않는다(N-25).
 * 「소개」가 누구 소개인지는 칸이 아니라 `LEAD_TOUCH` 의 한 줄이다(N-44).
 */
export const LEAD_SOURCES = ['kakao', 'phone', 'blog', 'instagram', 'referral', 'walkin'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  kakao: '카카오채널',
  phone: '전화',
  blog: '블로그',
  instagram: '인스타그램',
  referral: '소개',
  walkin: '워크인',
};

/** 유입 경로가 비어 있는 건 — 칩 줄의 마지막 칩. 「모른다」를 이름으로 만들지 않고 「없음」이라 적는다 */
export const LEAD_SOURCE_UNSET = 'none';
export const LEAD_SOURCE_UNSET_LABEL = '경로 없음';

export const leadSourceLabel = (source: string | null | undefined): string | null =>
  source == null ? null : (LEAD_SOURCE_LABEL[source as LeadSource] ?? source);

/**
 * 접촉 원장의 「어떻게」 — `LEAD_TOUCH.kind`(`lead_touch_kind_words` CHECK).
 * 전화 · 카카오톡 · 문자 · 방문 은 연락 수단, **상담 예약**(`book`)은 「언제 오기로 했나」를 적는 줄이고
 * **예약 불참**(`noshow`)은 테스트 시나리오 A-03 「상담 예약일에 오지 않음」의 자리다. 메모는 그 밖의 것.
 */
export const LEAD_TOUCH_KINDS = ['call', 'kakao', 'sms', 'visit', 'book', 'noshow', 'memo'] as const;
export type LeadTouchKind = (typeof LEAD_TOUCH_KINDS)[number];

export const LEAD_TOUCH_KIND_LABEL: Record<LeadTouchKind, string> = {
  call: '전화',
  kakao: '카카오톡',
  sms: '문자',
  visit: '방문',
  book: '상담 예약',
  noshow: '예약 불참',
  memo: '메모',
};

export const leadTouchKindLabel = (kind: string): string =>
  LEAD_TOUCH_KIND_LABEL[kind as LeadTouchKind] ?? kind;

/** 「+ 신규 문의」의 첫 접촉 한 줄은 어떻게 왔는지로 「어떻게」를 정한다 — 카카오채널 문의는 카카오톡, 전화 문의는 전화, 워크인은 방문 */
export const LEAD_SOURCE_TOUCH_KIND: Record<LeadSource, LeadTouchKind> = {
  kakao: 'kakao', phone: 'call', blog: 'memo', instagram: 'memo', referral: 'memo', walkin: 'visit',
};

/**
 * 단계 전이표 — `PATCH /ops/leads/:id/stage` 가 받아 주는 「다음 단계」 (N-45).
 *
 * 깔때기는 `1차 상담 › 2차 대기 › 2차 상담 › 보류` 이고 앞으로만 간다. 1차에서 2차 대기를 건너뛰고 바로 2차 상담을
 * 하는 날도 있고(그날 온 학부모), 어디서든 보류로 갈 수 있다. 보류가 풀리면 2차 대기나 2차 상담으로 **돌아온다**.
 * 등록·등록 실패는 여기 없다 — 등록은 `POST …/enroll`(C91 · 일곱 가지가 함께 서야 한다), 실패는 `POST …/fail`(N-25 · 중단 지점이 필수다)이
 * 각자의 길이고, 둘 다 끝난 결과라 이 표로는 옮기지 못한다(`LEAD_LOCKED`).
 */
export const LEAD_NEXT_STAGES: Record<IntakeStage, readonly IntakeStage[]> = {
  first: ['wait2nd', 'second', 'hold'],
  wait2nd: ['second', 'hold'],
  second: ['hold'],
  hold: ['wait2nd', 'second'],
  enrolled: [],
  failed: [],
};

export const leadNextStages = (stage: string): readonly IntakeStage[] =>
  LEAD_NEXT_STAGES[stage as IntakeStage] ?? [];

/* ══ 1:1 대조 wave 3 — 실패 사유 분류 · 재연락 · 단계 기한 (24-05 · 24-06 · 23-12) ═══════════════════ */

/**
 * 실패 사유 분류 다섯 — **낱말과 순서가 사는 단 하나의 자리** (원본 §24 카드 칩 · 「실패 사유 N건」 막대 · 24-05).
 * 저장값은 `LEAD.reason_kind`(`lead_reason_kind_words` CHECK · NULL 허용). 자유 글 `reason` 은 설명 칸으로 남는다.
 * 옛 실패 건은 NULL — 사유 글에서 분류를 추정하지 않는다(N-25). 화면에는 「분류 안 됨」으로 선다.
 */
export const LEAD_REASON_KINDS = ['unreachable', 'other_academy', 'schedule', 'cost', 'timing'] as const;
export type LeadReasonKind = (typeof LEAD_REASON_KINDS)[number];

export const LEAD_REASON_KIND_LABEL: Record<LeadReasonKind, string> = {
  unreachable: '연락 두절',
  other_academy: '타 학원 등록',
  schedule: '일정 안 맞음',
  cost: '비용',
  timing: '시기 안 맞음',
};

export const LEAD_REASON_KIND_UNSET = 'none';
export const LEAD_REASON_KIND_UNSET_LABEL = '분류 안 됨';

export const leadReasonKindLabel = (kind: string | null | undefined): string | null =>
  kind == null ? null : (LEAD_REASON_KIND_LABEL[kind as LeadReasonKind] ?? kind);

/**
 * 재연락 상태 (원본 §24 실패 카드의 「재연락 완료」 파랑 · 「재연락 대기」 주황 · 24-06).
 * **실패로 분류된 뒤에 접촉 원장에 한 줄이라도 있으면 완료**, 없으면 대기다. 실패 시각을 모르는 옛 건(도달 기록 없음)은
 * 앞뒤를 가를 수 없어 판정하지 않는다(null · N-25). 판정은 이 함수 하나 — 카드와 서랍이 같은 값을 읽는다.
 * `lastTouchAt`·`failedAt` 은 둘 다 `kstAt` 모양(`YYYY-MM-DDTHH:MI:SS+09:00`)이라 글자 순서가 시각 순서다.
 */
export function leadRecontactDone(failedAt: string | null, lastTouchAt: string | null): boolean | null {
  if (!failedAt) return null;
  return lastTouchAt !== null && lastTouchAt > failedAt;
}

/**
 * 단계 기한(SLA) — 슬라이드 23 규칙 「단계별 SLA 1차 2일 · 2차 대기 7일 · 2차 상담 1일 · 보류 2일」 (23-12).
 * 기한은 **그 단계에 들어온 날**(도달 기록의 마지막 줄 · 1차는 유입이 곧 도달이라 접수일)에서 센다.
 * 들어온 날을 모르는 옛 건은 기한을 만들지 않는다(N-25).
 */
export const INTAKE_STAGE_SLA_DAYS: Partial<Record<IntakeStage, number>> = {
  first: 2,
  wait2nd: 7,
  second: 1,
  hold: 2,
};

/** 기한 띠의 앞말 — 그 단계에서 **할 일**이다. 원본 §23 카드 띠의 낱말 그대로(2차 대기는 컷의 띠가 일정이라 칸 아래 줄의 동사를 쓴다) */
export const INTAKE_STAGE_TASK: Partial<Record<IntakeStage, string>> = {
  first: '2차 일정 + 진단고사 잡기',
  wait2nd: '2차 상담 진행',
  second: '보류 · 등록 · 등록 실패 중 선택',
  hold: '배치안 수락 여부 확인',
};

/** 날짜 문자열 + N일 (UTC 로 읽어 달력 날짜만 더한다 — 시간대가 끼지 않는다) */
const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** 날짜까지 남은 날 한 마디 — 「D-28」 · 「오늘」 · 「3일 지남」. 단계 기한 띠와 재연락 줄이 같은 말을 쓴다 */
export function leadDueLabel(dueOn: string, today: string): string {
  const diff = daysUntil(dueOn, today);
  return diff < 0 ? `${-diff}일 지남` : diff === 0 ? '오늘' : `D-${diff}`;
}

/**
 * 카드 띠 한 줄 — 「2차 일정 + 진단고사 잡기 · 오늘」 · 「배치안 수락 여부 확인 · 1일 지남」 · 「… · D-1」.
 * 톤은 지남 = danger(빨강 바탕) · 오늘 = warning(호박 바탕) · 그 밖 = neutral. 카드 바탕도 이 톤으로 칠한다(원본 §23).
 */
export function leadStageDue(
  stage: string, enteredOn: string | null, today: string,
  /** 단계 SLA 대신 쓰는 기한 — 보류의 재확인 날짜 · 2차 대기의 2차 일정(23-15 · 23-16). 할 일 낱말을 바꿀 때만 task 를 준다 */
  override?: { dueOn: string; task?: string } | null,
): { task: string; dueOn: string; dueLabel: string; tone: 'danger' | 'warning' | 'neutral' } | null {
  const days = INTAKE_STAGE_SLA_DAYS[stage as IntakeStage];
  const stageTask = INTAKE_STAGE_TASK[stage as IntakeStage];
  if (days == null || !stageTask) return null;
  const task = override?.task ?? stageTask;
  const dueOn = override?.dueOn ?? (enteredOn ? addDays(enteredOn, days) : null);
  if (!dueOn) return null;
  const diff = daysUntil(dueOn, today);
  return { task, dueOn, dueLabel: leadDueLabel(dueOn, today), tone: diff < 0 ? 'danger' : diff === 0 ? 'warning' : 'neutral' };
}

/**
 * 보류 재확인 날짜 (23-16) — 적어 둔 날짜가 있으면 그것, 없으면 보류에 들어온 날 + 2일(슬라이드 23 「D+2에 수락 여부 확인」).
 * 들어온 날도 모르는 옛 건은 null — 날짜를 짓지 않는다(N-25). 보류가 아니면 null.
 */
export function leadRecheckOn(stage: string, recheckOn: string | null, enteredOn: string | null): string | null {
  if (stage !== 'hold') return null;
  if (recheckOn) return recheckOn;
  return enteredOn ? addDays(enteredOn, INTAKE_STAGE_SLA_DAYS.hold ?? 2) : null;
}

/** 「연장 +2일」 한 번에 더하는 날 — 원본 §23 보류 카드 단추 낱말 그대로 */
export const LEAD_HOLD_EXTEND_DAYS = 2;

/**
 * 「연장 +2일」의 새 날짜 — 지금 유효한 재확인 날짜에서 이틀 뒤(원문 「연장 +2일」 · 기한을 늘린다).
 * 유효 날짜를 모르는 옛 건은 오늘을 기준으로 한다 — 사람이 지금 누른 것이라 과거를 짓는 것이 아니다.
 */
export function leadHoldExtended(current: string | null, today: string): string {
  return addDays(current ?? today, LEAD_HOLD_EXTEND_DAYS);
}

/* ── 배치안 초안 · 2차/진단 일정 (23-15 · 23-16) ── */

/** 배치안 한 줄의 낱말 — 「SAT Reading 주2 · Rebecca」(원본 §23 카드). 과목이 없으면 종류 이름, 강사가 없으면 뺀다 */
export function leadPlanLineLabel(line: { subName?: string | null; kindName?: string | null; perWeek: number; teacherName?: string | null }): string {
  const what = line.subName ?? line.kindName ?? '과목 미정';
  return `${what} 주${line.perWeek}${line.teacherName ? ` · ${line.teacherName}` : ''}`;
}

/**
 * 등록 카드의 「등록 수업」 한 줄 (23-11 · wave 6) — 원본 §23 등록 카드 「모의수업 A 주1 · KJ」 · 「MAP Reading 주3 · Allissa」.
 * 배치안 줄과 **같은 모양**이라 같은 함수(`leadPlanLineLabel`)로 만든다 — 등록 전의 초안과 등록 뒤의 수업이 같은 말로 읽힌다.
 * 「주N」은 매주 규칙의 요일 수다. 매일 · 격주는 「주N」이 거짓이 되므로 규칙 낱말(`ruleLabel` — 「2주마다 토」 · 「매일」)을 쓰고,
 * 단발(ONCE)은 정기 수업이 아니라 줄을 세우지 않는다(null). 규칙은 시간표가 정본이고 여기는 읽기만 한다.
 */
export function leadLessonLineLabel(line: { subName?: string | null; kindName?: string | null; rrule: string; teacherName?: string | null }): string | null {
  const rule = parseRule(line.rrule);
  if (rule.freq === 'ONCE') return null;
  if (rule.freq === 'WEEKLY' && rule.interval === 1 && rule.days.length > 0) {
    return leadPlanLineLabel({ subName: line.subName, kindName: line.kindName, perWeek: rule.days.length, teacherName: line.teacherName });
  }
  const what = line.subName ?? line.kindName ?? '과목 미정';
  return `${what} ${ruleLabel({ rrule: line.rrule })}${line.teacherName ? ` · ${line.teacherName}` : ''}`;
}

/**
 * 카드 단추 줄 (23-14 · wave 6) — 원본 §23 카드 아래의 단계별 단추. **서는 단추와 낱말은 이 표 한 곳**이다 (D-R18 · D-R39).
 * 컷 그대로: 1차 「(1차 카드 작성) · 2차 · 진단 잡기 · 바로 등록 · 여기서 종료」 / 2차 대기 「스케줄에 N건 만들기 · 2차 진행」 /
 * 2차 상담 「(2차 카드 작성) · 보류 · 등록 · 실패」 / 보류 「등록 · 실패 · 연장 +2일」 / 등록 「사후 관리」 / 등록 실패 「내역 · 상태 · 되살리기」.
 * 「1차/2차 카드 작성」은 양식 원문이 없어(23-17) 서버에 동작이 없다 — 표에 넣지 않는다(눌러도 아무 일 없는 단추를 세우지 않는다).
 * 단추마다 **이미 있는 서버 경로** 하나로 간다: appt → 2차·진단 일정(서랍) · enroll → 등록 확정 · fail → 실패 분류(중단 지점은 서랍에서 고른다) ·
 * schedule → 「스케줄에 N건 만들기」 · move → 단계 이동 · extend → 「연장 +2일」 · touch → 접촉 기록(서랍) · detail → 서랍 · resume → 되살리기.
 */
export const LEAD_CARD_ACTION_KEYS = ['appt', 'enroll', 'fail', 'schedule', 'move', 'extend', 'touch', 'detail', 'resume'] as const;
export type LeadCardActionKey = (typeof LEAD_CARD_ACTION_KEYS)[number];

const LEAD_CARD_ACTIONS: Record<IntakeStage, ReadonlyArray<{ key: LeadCardActionKey; label: string; to?: IntakeStage }>> = {
  first: [{ key: 'appt', label: '2차 · 진단 잡기' }, { key: 'enroll', label: '바로 등록' }, { key: 'fail', label: '여기서 종료' }],
  wait2nd: [{ key: 'schedule', label: '스케줄에 만들기' }, { key: 'move', label: '2차 진행', to: 'second' }],
  second: [{ key: 'move', label: '보류', to: 'hold' }, { key: 'enroll', label: '등록' }, { key: 'fail', label: '실패' }],
  hold: [{ key: 'enroll', label: '등록' }, { key: 'fail', label: '실패' }, { key: 'extend', label: '연장 +2일' }],
  enrolled: [{ key: 'touch', label: '사후 관리' }],
  failed: [{ key: 'detail', label: '내역 · 상태' }, { key: 'resume', label: '되살리기' }],
};

/**
 * 한 카드의 단추 줄 — 서버가 받아 주는 것만 선다.
 * - 단계 이동(`move`)은 **전이표(`LEAD_NEXT_STAGES`) 안의 곳만** — 이 표가 새 전이를 만들 수 없다(표에서 빠지면 단추도 빠진다).
 * - 「스케줄에 N건 만들기」는 시간표에 아직 없는 일정이 있을 때만 — 서버가 `LEAD_APPT_NONE` 으로 막는 바로 그 조건이다.
 * - 나머지는 그 단계에서 각 쓰기 경로가 받아 주는 단계와 같다(등록 확정 = 등록 아닌 건 · 실패 = 깔때기 안 · 연장 = 보류 · 되살리기 = 실패).
 */
export function leadCardActions(stage: string, opts: { unscheduledAppts: number }): Array<{ key: LeadCardActionKey; label: string; to: string | null }> {
  const next = leadNextStages(stage);
  const out: Array<{ key: LeadCardActionKey; label: string; to: string | null }> = [];
  for (const a of LEAD_CARD_ACTIONS[stage as IntakeStage] ?? []) {
    if (a.key === 'move' && !(a.to && next.includes(a.to))) continue;
    if (a.key === 'schedule') {
      if (opts.unscheduledAppts > 0) out.push({ key: 'schedule', label: `스케줄에 ${opts.unscheduledAppts}건 만들기`, to: null });
      continue;
    }
    out.push({ key: a.key, label: a.label, to: a.to ?? null });
  }
  return out;
}

/** 일정 종류 — 원본 §23 2차 대기 카드의 왼쪽 낱말 「진단」 · 「2차」 */
export const LEAD_APPT_KINDS = ['diag', 'second'] as const;
export type LeadApptKind = (typeof LEAD_APPT_KINDS)[number];
export const LEAD_APPT_KIND_LABEL: Record<LeadApptKind, string> = { diag: '진단', second: '2차' };
export const leadApptKindLabel = (k: string): string => LEAD_APPT_KIND_LABEL[k as LeadApptKind] ?? k;

/**
 * 시간표에 만들 때의 종류·과목 — 코드표의 「진단고사」(diagx · diag) · 「상담」(consult · intake).
 * 원본 머리의 「상담 일정」 탭이 시간표 상담 종류로 가는 것과 같은 짝이다. 코드표에 없으면 만들기를 막는다(서비스가 409).
 */
export const LEAD_APPT_SER_CODE: Record<LeadApptKind, { kindKey: string; subKey: string; title: string }> = {
  diag: { kindKey: 'diagx', subKey: 'diag', title: '진단고사' },
  second: { kindKey: 'consult', subKey: 'intake', title: '2차 상담' },
};

/** 일정 장소 한 마디 — 온라인이면 「온라인 줌」, 강의실이 있으면 그 이름, 없으면 「장소 미정」 */
export function leadApptPlaceLabel(mode: string, roomName: string | null): string {
  if (mode === 'online') return '온라인 줌';
  return roomName ?? '장소 미정';
}

/**
 * 등록률 — **등록 / (등록 + 등록 실패)** · 정수 반올림 · 분모 0 이면 0 (23-19 · N-22 · D-R44).
 *
 * 원본 §23 은 「전체 18 · 등록 3 · 등록 실패 6 · 등록률 33%」다. 33% 가 나오는 등록률 식은 **끝난 건 중 등록**
 * (3 / (3 + 6))뿐이다 — 등록 / 전체는 17% 이고, 실패 / 전체(6 / 18 = 33%)는 등록률이 아니다.
 * 채택문(§4-17)의 「원본 33% 재현 방향」대로 진행 중인 건(깔때기 안)을 분모에서 뺀다 — 아직 결과가 없는 건을 실패처럼 세지 않는다.
 */
export function intakeEnrollRate(enrolled: number, failed: number): number {
  const closed = enrolled + failed;
  return closed === 0 ? 0 : Math.round((enrolled / closed) * 100);
}

/**
 * 등록 카드의 사후 관리 줄 (23-18 · 원본 §23 「청구서 없음 · 교재 없음 · 안내 없음」) — 표시 낱말이 사는 단 하나의 자리.
 * 셋 다 그 학생의 원장에서 **읽기만** 한다: 청구서(INV) · 교재 배부(ISSUE) · 수업 안내(GUIDE).
 * 청구서 「없음」은 머리 경고 「등록했는데 청구서 없음」과 **같은 판정**(그 학생의 청구서 행이 하나도 없음)이다 — 두 자리가 다른 수를 말하지 않는다(D-R37).
 * 해피콜(첫 수업 + 7일 · A-14)은 「했는가」를 적을 원장이 없고, 월간 상담은 규칙이 정해지지 않아(DQ2) 줄을 세우지 않는다 — 지어내지 않는다.
 */
export const LEAD_AFTERCARE_KEYS = ['invoice', 'book', 'guide'] as const;
export type LeadAftercareKey = (typeof LEAD_AFTERCARE_KEYS)[number];
export const LEAD_AFTERCARE_LABEL: Record<LeadAftercareKey, string> = { invoice: '청구서', book: '교재', guide: '안내' };

export interface LeadAftercareCounts {
  /** 그 학생의 청구서 행 수(상태 무관 — 경고 「청구서 없음」과 같은 판정) */
  inv: number;
  /** 배부된 교재(ok) */
  bookOk: number;
  /** 배정을 기다리는 교재(wait · auto) */
  bookWait: number;
  /** 보낸 안내(sent · read) */
  guideSent: number;
  /** 쓰는 중인 안내(draft · ready) */
  guideDraft: number;
}

export function leadAftercareRows(c: LeadAftercareCounts): Array<{ key: LeadAftercareKey; label: string; value: string; done: boolean }> {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const inv = n(c.inv); const bookOk = n(c.bookOk); const bookWait = n(c.bookWait);
  const guideSent = n(c.guideSent); const guideDraft = n(c.guideDraft);
  return [
    { key: 'invoice', label: LEAD_AFTERCARE_LABEL.invoice, value: inv > 0 ? `${inv}건` : '없음', done: inv > 0 },
    {
      key: 'book', label: LEAD_AFTERCARE_LABEL.book,
      value: bookOk > 0 ? `${bookOk}권` : bookWait > 0 ? '배정 대기' : '없음', done: bookOk > 0,
    },
    {
      key: 'guide', label: LEAD_AFTERCARE_LABEL.guide,
      value: guideSent > 0 ? '보냄' : guideDraft > 0 ? '쓰는 중' : '없음', done: guideSent > 0,
    },
  ];
}
