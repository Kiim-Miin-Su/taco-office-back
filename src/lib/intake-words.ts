/** @file-guide
 * 목적: intake-words.ts — INTAKE_STAGES, IntakeStage, INTAKE_STAGE_LABEL, intakeStageLabel (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

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
