/** @file-guide
 * 목적: pay-request-key.ts — 입금 요청 키(안건 N-132)의 잠금 · 앞선 줄 판정 한 곳 (lib)
 * 책임/재사용: 청구서 입금 · 청구서 없는 입금 · 컨설팅 수납 세 쓰기가 같은 판정을 부른다. 쓰는 쪽은 그 트랜잭션의 EntityManager 로 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException } from '@nestjs/common';

/**
 * 안건 N-132(2026-09-29 권고 채택) — 같은 부분 입금을 두 번 보내면 둘 다 들어왔다.
 *
 * 청구서 행 `FOR UPDATE` + `OVERPAY` 는 **전액** 두 번만 막는다(누계가 청구액을 넘는다). 남은 금액 안의 같은 부분 금액은
 * 두 줄이 다 들어가 누계가 두 배가 됐다 — 끊긴 응답의 재시도 · 더블클릭 · 두 창. 리포트 발송(CR-BE-03) · 보호자 발송과
 * 같은 규약으로 푼다:
 *   · 같은 키 · 같은 내용 → 앞선 줄로 수렴한다(줄을 더하지 않는다). 동시에 와도 권고 잠금이 줄을 세워 둘째가 첫째의 줄을 본다.
 *   · 같은 키 · 다른 내용 → 409 `PAY_REQUEST_KEY_REUSED`(어느 쪽이 맞는지 서버가 고르지 않는다).
 *   · 지운 줄의 키 → 409(되살리지 않는다 — 지운 사실은 `log.before.requestKey` 에 있다).
 *   · 표의 부분 유니크(`pay_request_key_once` · `cons_pay_request_key_once`)가 이 판정을 우회한 쓰기까지 막는다.
 *
 * 부르는 쪽 규약: **입금을 쓰는 그 트랜잭션**에서 `lockPayRequestKey` 를 **다른 행 잠금보다 먼저** 부른다(잠금 차례를 세 쓰기에서 같게 —
 * 권고 잠금 → 청구서/컨설팅 행). 트랜잭션 밖에서 부르면 잠금이 문장과 함께 풀려 아무것도 지키지 못한다.
 */
export const PAY_REQUEST_KEY_DESCRIPTION =
  '재시도 · 더블클릭 중복 방지 키(안건 N-132) — 같은 키 · 같은 내용은 앞선 결과를 그대로 돌려주고 줄을 더하지 않는다. '
  + '같은 키 · 다른 내용이나 지운 줄의 키는 409 PAY_REQUEST_KEY_REUSED.';

type Queryer = { query(sql: string, params?: unknown[]): Promise<unknown> };

/** 같은 키의 요청을 한 줄로 세운다 — 트랜잭션이 끝날 때까지 쥔다(리포트 · 보호자 발송과 같은 해시) */
export async function lockPayRequestKey(q: Queryer, key: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

function reused(message: string): never {
  throw new ConflictException({ code: 'PAY_REQUEST_KEY_REUSED', message });
}

const SAME_KEY_OTHER_BODY = '같은 요청 키로 다른 입금이 이미 들어와 있습니다 — 새 입금이면 창을 다시 열어 새로 적어 주세요';
const SAME_KEY_DELETED = '이 요청으로 넣은 입금 줄은 이미 지워졌습니다 — 다시 넣으려면 새로 적어 주세요';

/** 비교할 때 빈 값은 하나로 — 화면이 안 보낸 칸(undefined)과 저장된 NULL · 공백뿐인 사유를 같게 본다 */
const blank = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** 입금 줄(PAY)의 요청 내용 — 청구서 입금은 invId, 청구서 없는 입금은 invId=null 과 학생이 짝이다 */
export interface PayRequestBody {
  invId: number | null;
  studentId: number | null;
  amount: number;
  paidOn: string;
  method?: string | null;
  reason?: string | null;
}

/**
 * 같은 키로 앞서 들어온 입금 줄의 id — 없으면 null.
 * 내용이 다르거나(청구서 입금의 키를 청구서 없는 입금이 빌려 온 경우 포함) 지운 줄의 키면 409.
 */
export async function priorPayForKey(q: Queryer, key: string, body: PayRequestBody): Promise<number | null> {
  const [row] = (await q.query(
    `SELECT id, inv_id, student_id, amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on, method, reason
       FROM pay WHERE request_key = $1`, [key],
  )) as Array<{
    id: string; inv_id: string | null; student_id: string | null; amount: number | null;
    paid_on: string | null; method: string | null; reason: string | null;
  }>;
  if (row) {
    const invSame = (row.inv_id == null ? null : Number(row.inv_id)) === body.invId;
    // 청구서 입금의 학생은 청구서가 정한다 — 학생은 청구서 없는 입금에서만 요청 내용이다
    const stuSame = body.invId != null || (row.student_id == null ? null : Number(row.student_id)) === body.studentId;
    const same = invSame && stuSame
      && Number(row.amount) === body.amount
      && row.paid_on === body.paidOn
      && blank(row.method) === blank(body.method)
      && blank(row.reason) === blank(body.reason);
    if (!same) reused(SAME_KEY_OTHER_BODY);
    return Number(row.id);
  }
  const gone = (await q.query(
    `SELECT 1 FROM log WHERE entity = 'PAY' AND action = 'delete' AND before->>'requestKey' = $1 LIMIT 1`, [key],
  )) as unknown[];
  if (gone.length) reused(SAME_KEY_DELETED);
  return null;
}

/** 컨설팅 수납 줄(CONS_PAY)의 요청 내용 */
export interface ConsPayRequestBody {
  consId: number;
  amount: number;
  paidOn: string;
  memo?: string | null;
}

/** 같은 키로 앞서 들어온 컨설팅 수납 줄의 id — 없으면 null. 내용이 다르면 409 (cons_pay 에는 지우는 길이 없다) */
export async function priorConsPayForKey(q: Queryer, key: string, body: ConsPayRequestBody): Promise<number | null> {
  const [row] = (await q.query(
    `SELECT id, cons_id, amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on, memo FROM cons_pay WHERE request_key = $1`, [key],
  )) as Array<{ id: string; cons_id: string; amount: number; paid_on: string; memo: string | null }>;
  if (!row) return null;
  const same = Number(row.cons_id) === body.consId
    && Number(row.amount) === body.amount
    && row.paid_on === body.paidOn
    && blank(row.memo) === blank(body.memo);
  if (!same) reused(SAME_KEY_OTHER_BODY);
  return Number(row.id);
}
