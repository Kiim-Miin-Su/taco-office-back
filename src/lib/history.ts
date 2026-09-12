/** @file-guide
 * 목적: history.ts — HIST_ENTITIES, HIST_ACTIONS, HistAction, histLabel, histSql (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §40 교재 이력 — **HIST 는 자기 화면이 없다.**
 *
 * 원본 §40 은 읽기만 하는 시간표고, 오른쪽에 「여기에 남는 것」이 적혀 있다:
 *   · 교재 배부 · 교체 · 제외 · 업로드
 *   · 강사 변경 요청과 처리 결과
 *   · 수업 안내 작성 · 발송 · 강사 확인
 *   · 강사 교체와 승계 내역
 *   · 6시간 마감 초과 기록
 *
 * 즉 이력은 **다른 쓰기의 부수효과**로 쌓인다. 그래서 낱말을 여기 한 곳에 두고
 * 쓰는 쪽이 `histSql()` 로 같은 문장을 쓴다 — 동작마다 자기 낱말을 지으면
 * 필터 칩과 실제로 쌓인 낱말이 갈린다 (D-R18).
 *
 * `hist` 표에는 설명 칸이 없다(`entity · ref_id · action · by_id · at` 뿐). 그래서
 * 화면에 보이는 문장은 **읽을 때 원본 표를 이어 붙여 만든다** — 쓸 때 문장을 굳혀 두면
 * 교재 이름이 바뀌어도 이력만 옛 이름으로 남는다.
 */

/** 이력이 가리키는 표 — `hist.entity` 는 varchar(12) 다 */
export const HIST_ENTITIES = ['lib', 'vers', 'issue', 'guide', 'pnoti', 'ser'] as const;
export type HistEntity = (typeof HIST_ENTITIES)[number];

/**
 * 이력에 남는 동작 — **원본 §40 의 필터 칩 그대로**다.
 * 칩에 없는 낱말을 쌓으면 그 줄은 「전체」에만 보이고 어느 칩에도 안 걸린다.
 */
export const HIST_ACTIONS = [
  'book_issue',    // 교재 배부
  'book_upload',   // 교재 업로드 (새 판)
  'book_swap',     // 교재 교체 (판 바꾸기)
  'book_drop',     // 교재 제외
  'guide_write',   // 안내 작성
  'guide_send',    // 안내 발송
  'guide_ack',     // 강사 확인
  'teacher_req',   // 강사 요청
  'teacher_swap',  // 강사 교체
] as const;
export type HistAction = (typeof HIST_ACTIONS)[number];

/** 칩과 줄에 쓰는 이름 — 낱말을 만드는 자리는 여기 하나다 */
export const HIST_ACTION_LABEL: Record<HistAction, string> = {
  book_issue: '교재 배부',
  book_upload: '교재 업로드',
  book_swap: '교재 교체',
  book_drop: '교재 제외',
  guide_write: '안내 작성',
  guide_send: '안내 발송',
  guide_ack: '강사 확인',
  teacher_req: '강사 요청',
  teacher_swap: '강사 교체',
};

export const histLabel = (action: string): string =>
  HIST_ACTION_LABEL[action as HistAction] ?? action;

/**
 * 이력 한 줄을 남기는 문장.
 *
 * 쓰는 쪽은 `m.query(histSql(), [entity, refId, action, byId])` 로 부른다 —
 * 문장을 각자 적으면 칸 순서가 어긋나도 타입이 안 잡는다.
 * **쓰기와 같은 트랜잭션 안에서** 불러야 한다. 밖에서 부르면 쓰기는 되돌아가고
 * 이력만 남아 「하지도 않은 일」이 장부에 찍힌다.
 */
export const histSql = (): string =>
  `INSERT INTO hist (entity, ref_id, action, by_id, at) VALUES ($1, $2, $3, $4, now())`;
