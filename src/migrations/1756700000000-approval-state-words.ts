import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 결재 상태의 **낱말을 하나로** 모은다 — `pending → approved | rejected`.
 *
 * 세 곳이 서로 다른 말을 하고 있었다.
 *   `erd.dbml`   CHREQ.state = 'open | applied | denied', 기본값 'open'
 *   REQ.state    기본값 'open' (낱말은 안 적혀 있었다)
 *   시드와 실제 행  'pending' · 'approved' · 'rejected'
 *
 * 그래서 **기본값으로 들어간 행은 아무도 못 읽는 말**을 갖고 태어났다.
 * `POST /drawer/change-requests` 로 넣은 요청이 정확히 그 자리였다 — 목록에는
 * 뜨지만 상태 칸이 영어 낱말 그대로 나오고, 배지 분류도 「기다리는 것」으로만 떨어진다.
 *
 * 고르는 기준은 「실제로 돌고 있는 것」이다. 행 4건과 시드가 이미 pending/approved/rejected 를
 * 쓰고 PLAN.stage 도 approved 를 쓰므로, 그쪽으로 기본값과 남은 행을 옮긴다.
 * `erd.dbml` 의 주석도 같은 커밋에서 고쳤다 — 표가 이름의 출처다 (D-R18).
 */
export class ApprovalStateWords1756700000000 implements MigrationInterface {
  name = 'ApprovalStateWords1756700000000';

  /** 옛 낱말 → 새 낱말 */
  private static readonly MAP: Array<[string, string]> = [
    ['open', 'pending'],
    ['applied', 'approved'],
    ['denied', 'rejected'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    // GPAPACK 도 결재 다섯 갈래 중 하나다 — 표가 이미 있는데 낱말만 옛것이었다
    for (const table of ['chreq', 'req', 'gpapack']) {
      for (const [from, to] of ApprovalStateWords1756700000000.MAP) {
        await q.query(`UPDATE ${table} SET state = $1 WHERE state = $2`, [to, from]);
      }
      await q.query(`ALTER TABLE ${table} ALTER COLUMN state SET DEFAULT 'pending'`);
    }
    // PLAN 은 단계가 더 많다 (draft · review · rework · approved) — 끝 낱말만 맞춘다
    await q.query(`UPDATE plan SET stage = 'approved' WHERE stage IN ('ok', 'done')`);
  }

  /**
   * 되돌리지 않는다. 낱말을 옛것으로 돌리면 **읽는 쪽이 다시 못 읽는 상태**가 되고,
   * 그 사이에 들어온 행까지 'open' 으로 바뀌어 되돌릴 수도 없다.
   */
  public async down(): Promise<void> {
    throw new Error(
      '되돌리지 않습니다 — 결재 낱말을 옛것(open/applied/denied)으로 되돌리면 '
      + '화면과 배지가 다시 못 읽습니다. 필요하면 새 마이그레이션으로 앞으로 고치세요.',
    );
  }
}
