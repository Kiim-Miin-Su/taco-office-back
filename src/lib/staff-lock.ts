/** @file-guide
 * 목적: staff-lock.ts — lockActiveStaff (lib)
 * 책임/재사용: 「담당으로 지정할 활성 구성원」을 같은 트랜잭션에서 잠가 읽는 한 함수. 담당 지정 쓰기(기획·마케팅·상담 …)가 전부 이것을 부른다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 담당 지정과 계정 비활성화의 경쟁 (TBO-54 코드 리뷰 CR-BE-04).
 *
 * 전에는 담당을 지정하기 전에 `SELECT … FROM staff WHERE id = $1 AND active` 를 **잠금 없이** 읽고 저장했다.
 * 그 확인과 저장 사이에 서랍의 「사용 중지」(`UPDATE staff SET active = false`)가 커밋되면 **그만둔 사람이 담당으로 저장**된다 —
 * READ COMMITTED 에서 잠금 없는 SELECT 는 아직 커밋되지 않은 비활성화를 보지 못하기 때문이다.
 *
 * **FOR SHARE 를 건다 — FOR KEY SHARE 는 부족하다.** 비활성화는 키가 아닌 칸(active)만 고치는 UPDATE 라 행에 FOR NO KEY UPDATE 잠금을
 * 잡는데, FOR KEY SHARE 는 그것과 **충돌하지 않는다**(키를 고치는 UPDATE · DELETE 하고만 충돌한다). FOR SHARE 는 FOR NO KEY UPDATE ·
 * FOR UPDATE 둘 다와 충돌하므로 —
 *   · 지정이 먼저면 비활성화 UPDATE 가 이 트랜잭션의 커밋을 기다린다(여러 지정끼리는 함께 읽는다 · `assertZaccAssignable` 과 같은 선택).
 *   · 비활성화가 먼저면 이 SELECT 가 그 커밋을 기다린 뒤 **최신 행으로** `active` 를 다시 판정한다(WHERE 재평가) — 비활성이면 행이 없다.
 * 서랍이 지금 `FOR UPDATE` 로 먼저 잠그는 것에 기대지 않는다 — 실제 UPDATE 의 잠금 강도와 대조해 고른 것이다.
 *
 * 부르는 쪽 규약: **담당을 저장하는 그 트랜잭션의 EntityManager/QueryRunner** 로 부른다. 트랜잭션 밖에서 부르면 잠금이 문장과 함께 풀려
 * 아무것도 지키지 못한다. 없거나 비활성이면 null — 어떤 오류를 던질지는 부르는 쪽이 정한다(지금은 전부 404 `STAFF_NOT_FOUND`).
 */
export async function lockActiveStaff(
  q: { query(sql: string, params?: unknown[]): Promise<unknown> },
  id: number,
): Promise<{ id: number; name: string } | null> {
  const rows = (await q.query(
    `SELECT id, name FROM staff WHERE id = $1 AND active FOR SHARE`, [id],
  )) as Array<{ id: string | number; name: string }>;
  const st = rows[0];
  return st ? { id: Number(st.id), name: st.name } : null;
}
