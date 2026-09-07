import { MigrationInterface, QueryRunner } from 'typeorm';

/** 변경 이력은 당시 SQL로 고정한다. 실행 시점의 도메인 함수에 의존하지 않는다. */
async function consultingContractPreflight(q: QueryRunner): Promise<Record<string, number>> {
  const [counts] = await q.query(`SELECT
    (SELECT count(*)::int FROM cons WHERE stage NOT IN ('contract','running','done')) AS invalid_stage,
    (SELECT count(*)::int FROM cons WHERE contract_step IS NOT NULL AND contract_step NOT BETWEEN 1 AND 5) AS invalid_step,
    (SELECT count(*)::int FROM cons WHERE stage IN ('running','done') AND contract_step IS DISTINCT FROM 5) AS unpaid_stage,
    (SELECT count(*)::int FROM cons WHERE sessions <= 0) AS invalid_sessions,
    (SELECT count(*)::int FROM cons_sess WHERE seq <= 0) AS invalid_seq,
    (SELECT count(*)::int FROM (SELECT cons_id,seq FROM cons_sess GROUP BY cons_id,seq HAVING count(*) > 1) d) AS duplicate_seq
  `) as Record<string, number>[];
  return counts;
}

/** TBO-47C: 기존 행은 보정/삭제하지 않는다. 제약 추가만 허용한다. */
export class ConsultingContract1757500000000 implements MigrationInterface {
  name = 'ConsultingContract1757500000000';

  preflight(q: QueryRunner): Promise<Record<string, number>> {
    return consultingContractPreflight(q);
  }

  async up(q: QueryRunner): Promise<void> {
    const counts = await consultingContractPreflight(q);
    if (Object.values(counts).some((n) => n !== 0)) {
      throw new Error(`Consulting contract preflight failed: ${JSON.stringify(counts)}`);
    }
    // CHECK 생성 자체도 기존 행을 검증하므로 preflight 이후 유입된 오염 역시 차단된다.
    await q.query(`ALTER TABLE cons
      ADD CONSTRAINT cons_stage_check CHECK (stage IN ('contract','running','done')),
      ADD CONSTRAINT cons_contract_step_check CHECK (contract_step BETWEEN 1 AND 5),
      ADD CONSTRAINT cons_paid_stage_check CHECK (stage = 'contract' OR contract_step IS NOT DISTINCT FROM 5),
      ADD CONSTRAINT cons_sessions_check CHECK (sessions > 0)`);
    await q.query(`ALTER TABLE cons_sess
      ADD CONSTRAINT cons_sess_seq_check CHECK (seq > 0),
      ADD CONSTRAINT cons_sess_cons_seq_uniq UNIQUE (cons_id, seq)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE cons_sess
      DROP CONSTRAINT cons_sess_cons_seq_uniq, DROP CONSTRAINT cons_sess_seq_check`);
    await q.query(`ALTER TABLE cons
      DROP CONSTRAINT cons_sessions_check, DROP CONSTRAINT cons_paid_stage_check,
      DROP CONSTRAINT cons_contract_step_check, DROP CONSTRAINT cons_stage_check`);
  }
}
