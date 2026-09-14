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
};

export const todoSourceLabel = (source: string): string =>
  TODO_SOURCE_LABEL[source as TodoSrcT] ?? source;
