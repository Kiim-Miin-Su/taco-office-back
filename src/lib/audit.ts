/** @file-guide
 * 목적: audit.ts — 감사 원장(`log`)에 남길 쓰기의 목록 한 벌과 남기는 함수 한 곳 (N-73 채택 · 2026-09-26 W11)
 * 책임/재사용: 「어디까지 남기는가」의 정본이다. 새로 남기는 자리는 이 표에 먼저 적고 `audit()` 로만 쓴다(쓰기와 같은 트랜잭션).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * N-73 채택(대표 위임 2026-09-26 · W11) — 「② 돈 · 삭제 · 권한 · 결재 도장으로 긋고 ① 정본 표를 상한으로」.
 *
 * - **정본 표의 쓰기만** 남긴다. 투영 표(`ser_occ` · `zassign` 의 투영 줄)는 쓰기마다 구간을 다시 쓰므로 남기지 않는다 —
 *   남기면 원장이 수백 줄씩 불어 무엇이 실제 변경인지 못 고른다. 스케줄은 **SER(규칙) 단위 한 줄**이다.
 * - **쓰기와 같은 트랜잭션**에 남긴다. 밖에서 남기면 쓰기는 되돌아가고 줄만 남아 「하지도 않은 일」이 장부에 찍힌다(S7).
 * - `log.entity` 는 옛 값을 고치지 않는다(`rpt` · `plan` 소문자 포함 · N-25) — §61 「보완 N」이 `plan` 을 읽는다.
 *   새 줄은 이 표의 이름(대문자)을 쓴다.
 * - 이 표에 없는 자리는 새로 남기지 않는다. 늘릴 때는 표에 한 줄을 더하고 그 쓰기에 `audit()` 한 줄을 더한다.
 *
 * 이미 남기고 있던 자리(S7 다섯 · 서랍 쓰기 · 상담 · 컴플레인 · 대표 보고 등)는 그대로 둔다 — 인라인 INSERT 를 여기로 옮기는 일은
 * 동작이 같은 리팩터링이라 이 청크 밖이다(최소 변경).
 */

/** 새로 남기는 쓰기 목록 — key 는 시험 · 문서가 부르는 이름, entity · action 은 `log` 에 적히는 값(varchar 20) */
export const AUDIT_WRITES = [
  // 스케줄 — 규칙(SER) 단위 한 줄 · 여러 규칙을 한 번에 바꾸는 쓰기는 규칙마다 한 줄
  { key: 'schedule.create', entity: 'SER', action: 'create', why: '회차가 청구 · 정산의 원천이다(원문 슬라이드 7 「EXC · LOG」)' },
  { key: 'schedule.patch', entity: 'SER', action: 'patch', why: '옮김 · 강사 · 강의실 · 방식 변경(원문 슬라이드 7)' },
  { key: 'schedule.delete', entity: 'SER', action: 'delete', why: '삭제 · 휴강(되돌릴 수 있는 삭제 — N-55 곁가지)' },
  { key: 'schedule.day_cancel', entity: 'SER', action: 'day_cancel', why: '그날 전체 휴강' },
  { key: 'schedule.move', entity: 'SER', action: 'move', why: '여러 회차 옮기기' },
  { key: 'schedule.paste', entity: 'SER', action: 'paste', why: '붙여넣기로 만든 규칙' },
  { key: 'schedule.roster', entity: 'SER', action: 'roster', why: '명단 넣기 · 빼기(청구 인원 · 단가 구간이 바뀐다)' },
  { key: 'schedule.undo', entity: 'SER', action: 'undo', why: '되돌리기 — 누가 언제 되살렸는지' },
  // 리포트 — 결재 도장을 지우는 쓰기
  { key: 'report.write', entity: 'REP', action: 'write', why: '다시 쓰면 결재 도장이 지워진다' },
  // 회계 — 돈
  { key: 'invoice.issue', entity: 'INV', action: 'issue', why: '청구서 발행(낱장 · 일괄 · 등록 확정)' },
  { key: 'expense.review', entity: 'EXPENSE', action: 'review', why: '지출 승인 · 반려 · 확정 금액' },
  { key: 'carry.create', entity: 'CARRY', action: 'create', why: '이월 처리' },
  // 컨설팅 — 돈
  { key: 'consulting.to_invoice', entity: 'CONS', action: 'to_invoice', why: '청구서로 전환' },
  { key: 'consulting.core', entity: 'CONS', action: 'edit', why: '계약 작업 전 학생 · 요청자 · 담당 · 금액 · 회차 · 기간 수정' },
  // 컨설팅 — W11(C1) 결정이 만든 쓰기: 예외 종료(결재) · 항목 빼기 · 항목 파일 빼기 · 지우기(삭제)
  { key: 'consulting.close_exception', entity: 'CONS', action: 'close_exception', why: '예외 종료 — 사유 · 승인자 · 남은 항목과 회차(N-18-a · DQ6)' },
  { key: 'consulting.items', entity: 'CONS', action: 'items', why: '항목 수정 — 더하기 · 이름 바꾸기 · 빼기(N-18-a · 원문 §31)' },
  { key: 'consulting.item_file', entity: 'CONS', action: 'item_file_delete', why: '항목 파일 빼기(N-63)' },
  { key: 'consulting.archive', entity: 'CONS', action: 'archive', why: '지우기(보관) — 목록 · §28 합계에서 빠진다(PB-11)' },
  // 삭제 · 권한 · 설정
  { key: 'unav.delete', entity: 'UNAV', action: 'delete', why: '강사 불가 시간 삭제' },
  { key: 'zoom.account', entity: 'ZACC', action: 'update', why: '줌 계정 수정(참가 링크 · 비밀 값 교체)' },
  { key: 'gpapack.write', entity: 'GPAPACK', action: 'write', why: 'GPA 자료 묶음 만들기 · 전달 · 수령' },
  { key: 'catalog.kind', entity: 'KIND', action: 'write', why: '수업 종류 만들기 · 고치기 · 끄기' },
  { key: 'catalog.sub', entity: 'SUB', action: 'write', why: '과목 만들기 · 고치기 · 끄기' },
  { key: 'guide.template', entity: 'GTPL', action: 'write', why: '문구 틀 만들기 · 고치기' },
  { key: 'meeting.minutes', entity: 'MTREC', action: 'minutes', why: '회의 속기록(통째로 덮어쓰는 쓰기)' },
  { key: 'change_request.review', entity: 'CHREQ', action: 'review', why: '변경 요청 반영 · 반려(시간표가 바뀐다)' },
  { key: 'request.review', entity: 'REQ', action: 'review', why: '요청 승인 · 반려(시급 · 시간대가 바뀐다)' },
  { key: 'approval.undo', entity: 'REQ', action: 'undo', why: '결재 되돌리기(N-84)' },
  // W11 운영 · 대표 보고 (O) — 권한 · 결재 쓰기
  { key: 'plan.share', entity: 'PLAN', action: 'share', why: '기획 공개 범위 · 지정된 사람 바꾸기(누가 보는가 · N-72)' },
  { key: 'exec.area_owner', entity: 'EXEC_AREA', action: 'owner', why: '대표 보고 영역 담당 지정(N-81)' },
  { key: 'report.withdraw', entity: 'RPT', action: 'withdraw', why: '대표 보고 회수 — 올린 서명을 지운다(N-97)' },
  // W11 서랍 · 권한 (P) — 결재 되돌리기의 변경 요청 갈래 · 사람별 권한 예외
  { key: 'approval.undo_chreq', entity: 'CHREQ', action: 'undo', why: '변경 요청 결재 되돌리기 — 일정 되돌리기와 같은 트랜잭션(N-84)' },
  { key: 'staff.perms', entity: 'STAFF', action: 'perms', why: '사람별 권한 예외 켬 · 끔 · 역할 따름(N-68 · 권한)' },
  // W11 M2 강사료 정산 · 회계 비공개 (N-93 · N-94 · N-51) — 돈 · 권한 쓰기. 지급 확정은 기존 인라인 LOG(PAYOUT confirm)를 그대로 둔다
  { key: 'payout.bonus_rule', entity: 'PAYOUT_BONUS', action: 'write', why: '가산 규칙 새 줄 — 시트 · 확정 · 강사 히스토리 금액이 바뀐다(N-93)' },
  { key: 'acct.privacy', entity: 'ACCT_PRIVACY', action: 'switch', why: '시급 · 컨설팅 비공개 켬 · 끔 — 누가 줄 금액을 보는가(N-94)' },
  { key: 'payout.correction', entity: 'PAYOUT', action: 'correction', why: '보정 승인 — 확정된 달 뒤에 쓴 회차를 다음 달 정산에 얹어 지급(N-51 · 슬라이드 77)' },
] as const;

export type AuditKey = (typeof AUDIT_WRITES)[number]['key'];
type AuditRow = (typeof AUDIT_WRITES)[number];

const BY_KEY: ReadonlyMap<string, AuditRow> = new Map(AUDIT_WRITES.map((row) => [row.key, row]));

/** 쿼리 실행 모양 — QueryRunner · EntityManager · DataSource 어느 것이든 `query` 하나만 쓴다 */
export interface AuditQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface AuditInput {
  actorId: number | string;
  entityId: number | string;
  /** 바뀌기 전(없으면 생략 · 만들기) */
  before?: Record<string, unknown> | null;
  /** 바뀐 뒤(없으면 생략 · 지우기) */
  after?: Record<string, unknown> | null;
  /** 표의 action 대신 적을 낱말(예: 반려 → `reject`) — 20자 안 */
  action?: string;
}

/**
 * 감사 한 줄 — 반드시 쓰기와 **같은 트랜잭션**의 `q` 로 부른다.
 * 비밀 값(비밀번호 · 해시 · 줌 비밀번호 · 토큰)은 before · after 에 넣지 않는다 — 부르는 쪽이 걸러서 준다.
 */
export async function audit(q: AuditQueryable, key: AuditKey, input: AuditInput): Promise<void> {
  const row = BY_KEY.get(key);
  if (!row) throw new Error(`감사 목록에 없는 쓰기: ${key}`);
  const action = input.action ?? row.action;
  if (action.length > 20) throw new Error(`감사 action 이 20자를 넘는다: ${action}`);
  await q.query(
    `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      Number(input.actorId),
      row.entity,
      Number(input.entityId),
      action,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
    ],
  );
}
