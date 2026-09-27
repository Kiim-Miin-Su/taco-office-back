/** @file-guide
 * 목적: TODO.src 저장값을 §15에서 쓰는 사람이 읽는 이름으로 한 번만 변환한다.
 * 책임/재사용: 순수 코드표만 소유하며 UI 색·DB 쓰기·권한 판정을 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { TodoSrcT } from '../entities/enums';

export const TODO_SOURCE_LABEL: Record<TodoSrcT, string> = {
  meeting: '회의',
  complaint: '컴플레인',
  consulting: '컨설팅',
  plan: '기획',
  manual: '직접 등록',
  lesson: '수업',
  // W11 · N-86 — 등록 뒤 사후 관리(해피콜 · 월간 상담)는 상담 담당의 할 일이다. 출처 칩은 상담 화면(§23)의 이름
  lead: '상담',
};

export const todoSourceLabel = (source: string): string =>
  TODO_SOURCE_LABEL[source as TodoSrcT] ?? source;

/**
 * §15 「끝난 것 지우기」가 건드리지 않는 출처 (W11 A' · N-86 「완료 이력은 지우지 않는다」).
 * 상담 사후 관리(해피콜 · 월간 상담)는 끝낸 줄이 곧 이력이다 — 등록 카드의 「완료 03-18」이 그 줄을 읽는다.
 * 서랍 줄의 `clearable` · 지우는 쓰기의 WHERE 가 이 한 목록을 쓴다(판정 한 곳 · 화면은 플래그만 읽는다).
 */
export const TODO_KEEP_ON_CLEAR: readonly TodoSrcT[] = ['lead'];

/** 지우지 않는 까닭 — 서랍이 그대로 보여 주는 서버 문장 */
export const TODO_KEEP_REASON = '상담 사후 관리(해피콜 · 월간 상담)는 끝나도 이력으로 남습니다';

export const todoClearable = (source: string): boolean =>
  !(TODO_KEEP_ON_CLEAR as readonly string[]).includes(source);

/**
 * 할 일 한 줄의 원본 키 — 표 `todo` 의 출처 칸들. 수업은 회차 키(`serId` · `onDate` = 규칙이 찍은 날)와
 * **그려지는 날**(`drawnOn` — 옮긴 회차면 `onDate` 와 다르다 · 회차가 투영에 없으면 null)을 함께 준다.
 */
export interface TodoSourceKeys {
  mtId?: unknown;
  cplId?: unknown;
  consId?: unknown;
  planId?: unknown;
  leadId?: unknown;
  serId?: unknown;
  onDate?: string | null;
  drawnOn?: string | null;
}

const refId = (v: unknown): number | null => (v == null || v === '' ? null : Number(v) || null);

/**
 * 연결 수업 한 회차를 여는 시간표 주소 — §64 「연결 수업」 칩(N-71)과 할 일의 「원본」이 같은 주소를 쓴다.
 * 시간표는 그려지는 날의 범위를 읽고 그 안에서 (serId, onDate) 회차를 찾아 수업 상세를 연다 — 그려지는 날을 모르면 보내지 않는다.
 */
export function todoLessonGo(serId: unknown, onDate: string | null | undefined, drawnOn: string | null | undefined): string | null {
  const ser = refId(serId);
  return ser && onDate && drawnOn ? `/schedule?date=${drawnOn}&serId=${ser}&onDate=${onDate}` : null;
}

/**
 * 할 일의 「원본」 — 출처로 돌아가는 이동 링크 (원문 §15 · §64 「출처가 있는 할 일은 원본으로 돌아갈 수 있습니다」).
 * **서랍 §15 와 운영 §64 가 이 한 함수를 쓴다** (W11 A' 후속 2 · 링크를 서버가 짓고 화면은 그대로 그린다).
 * 대상 화면이 **한 건을 여는 질의를 이미 읽는 것만** 만든다 — 회의 상세 · 컴플레인 처리 창 · 기획 보고서(운영 화면) ·
 * 컨설팅 건 · 상담 건 · 수업 상세(시간표). 그 밖(손으로 만든 할 일 · 투영에 없는 회차)은 null — 없는 곳으로 보내지 않는다.
 */
export function todoGo(k: TodoSourceKeys): string | null {
  const mt = refId(k.mtId);
  if (mt) return `/ops?tab=meeting&meeting=${mt}`;
  const cpl = refId(k.cplId);
  if (cpl) return `/ops?tab=complaint&cpl=${cpl}`;
  const cons = refId(k.consId);
  if (cons) return `/consulting?id=${cons}`;
  const plan = refId(k.planId);
  if (plan) return `/ops?tab=plan&plan=${plan}`;
  const lead = refId(k.leadId);
  if (lead) return `/intake?lead=${lead}`;
  return todoLessonGo(k.serId, k.onDate, k.drawnOn);
}
