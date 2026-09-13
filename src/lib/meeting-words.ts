/** @file-guide
 * 목적: meeting-words.ts — MT_TYPES, MtType, MT_TYPE_LABEL, mtTypeLabel, MT_ATTEND_STATES 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §63 회의 목록 · §66 회의 상세의 **낱말 한 벌**.
 *
 * 한동안 §63 표가 `mt_type` 코드값을 그대로 찍고 있었다 — 「general」 「plan」 (D-R18).
 *
 * 이름은 지어낸 것이 아니다. 명세서 슬라이드 66 이 「회의 종류 **5종**(기획·컨설팅·마케팅·
 * 개발·일반)」이라 적고, 슬라이드 89 의 과목 표가 그 다섯을 **「기획 회의 · 컨설팅 회의 ·
 * 마케팅 회의 · 개발 회의 · 일반 회의」**라고 이름까지 적어 둔다. 원문 §66 컷의 머리도
 * 「일반 회의」다.
 *
 * ⚠️ `mt_type` 코드(`plan`·`consulting`…)와 과목 키(`mt-pl`·`mt-cs`…)는 **다른 값**이다.
 * 한 회의가 둘 다 갖는 것이 아니라, 같은 다섯 갈래를 두 표가 각자 부른다. 이름만 맞춘다.
 */
export const MT_TYPES = ['plan', 'consulting', 'marketing', 'dev', 'general'] as const;
export type MtType = (typeof MT_TYPES)[number];

export const MT_TYPE_LABEL: Record<MtType, string> = {
  plan: '기획 회의',
  consulting: '컨설팅 회의',
  marketing: '마케팅 회의',
  dev: '개발 회의',
  general: '일반 회의',
};

/** 모르는 코드값이면 코드값을 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다 */
export const mtTypeLabel = (t: string): string => MT_TYPE_LABEL[t as MtType] ?? t;

/* ── 참석 (MTATTD) ─────────────────────────────────────────────────────── */

/**
 * `mtattd.confirmed` 는 **세 값**이다 — `null`(아직 답 안 함) · `true`(참석) · `false`(불참).
 * 원문 §66 의 칩이 「응답 대기」인 것이 곧 `null` 이다. `null` 을 `false` 로 접으면
 * 「불참하겠다고 답한 사람」과 「아직 안 본 사람」이 같은 칩을 달게 된다.
 */
export const MT_ATTEND_STATES = ['waiting', 'in', 'out'] as const;
export type MtAttendState = (typeof MT_ATTEND_STATES)[number];

export const MT_ATTEND_LABEL: Record<MtAttendState, string> = {
  waiting: '응답 대기',
  in: '참석',
  out: '불참',
};

export function mtAttendState(confirmed: boolean | null | undefined): MtAttendState {
  if (confirmed === null || confirmed === undefined) return 'waiting';
  return confirmed ? 'in' : 'out';
}

/* ── 속기록 (MTREC.minutes) ────────────────────────────────────────────── */

/**
 * 원문 §66 속기록 칸 아래의 **끼워 넣기 단추 넷**과 오른쪽 안내 한 줄.
 *
 * 이 낱말이 화면에만 있으면 회의마다 머리말이 제각각이 되고, 나중에 속기록을 훑어
 * 「정한 것」만 뽑는 일이 불가능해진다. 서버가 같은 말을 내려보낸다 (D-R18).
 */
export const MINUTES_TEMPLATES = ['[정한 것]', '[누가 무엇을]', '[다음 회의까지]', '[보류]'] as const;

/** 원문 컷의 오른쪽 안내 문구 그대로 */
export const MINUTES_HINT = '정한 것 · 누가 무엇을 · 다음 회의까지';
