/** @file-guide
 * 목적: catalog-words.ts — KIND_GROUPS, KindGroup, KIND_GROUP_LABEL, kindGroupLabel (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 프로그램 묶음의 **낱말 한 벌** — 표의 `kind_grp_t` 와 같은 코드값, 그리고 사람이 읽는 이름.
 *
 * 두 곳이 이 낱말을 내려보낸다: §18 서랍(`KindRowDto`)과 §18 목적지(`KindRowsDto`).
 * 한동안 서랍 쪽만 화면에 코드표를 다시 적고 있었고, 그 표가 원문과 달랐다 —
 * 원문 §18 은 「상담·진단」인데 화면은 「상담」이라고 적었다 (D-R18).
 * 낱말을 만드는 자리는 여기 하나다.
 */
export const KIND_GROUPS = ['lesson', 'intake', 'meeting'] as const;
export type KindGroup = (typeof KIND_GROUPS)[number];

/** 원문 §18 서랍의 묶음 머리글 그대로다 — 「수업 4 · 상담·진단 3 · 회의 1」 */
export const KIND_GROUP_LABEL: Record<string, string> = {
  lesson: '수업',
  intake: '상담·진단',
  meeting: '회의',
};

/** 모르는 코드값이면 코드값을 그대로 보인다 — 비어 보이느니 낯설게 보이는 편이 낫다 */
export const kindGroupLabel = (grp: string): string => KIND_GROUP_LABEL[grp] ?? grp;
