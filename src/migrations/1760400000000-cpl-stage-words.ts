import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CPL.stage 에 낱말 제약을 새긴다 — C86-d.
 *
 * **선언과 데이터가 달랐고, 그 차이를 읽은 쪽이 조용히 틀렸다.** DBML 의 `CPL.stage` 주석과
 * entity 주석은 둘 다 「open | acting | done」이라 적어 두었는데 실제로 저장되는 말은
 * `received | acting | closed` 다. `lib/exec-areas` 의 컴플레인 판정이 그 선언을 믿고
 * `stage <> 'done'` 으로 세는 바람에 **끝난 건까지 전부 세어** 대표 보고 배지가 8 이 됐다
 * (열린 건은 5다). 표에 제약이 없어 아무도 막지 못했다.
 *
 * **기존 행은 보정하지 않는다** (N-25). 다른 낱말이 들어 있으면 **세어서 멈춘다** —
 * 어느 쪽이 맞는지는 사람이 정한다. 비어 있으면 그대로 새긴다.
 */
export class CplStageWords1760400000000 implements MigrationInterface {
  name = 'CplStageWords1760400000000';

  public async up(q: QueryRunner): Promise<void> {
    const rows = (await q.query(
      `SELECT stage, count(*)::int AS n FROM cpl
        WHERE stage NOT IN ('received','acting','closed')
        GROUP BY stage ORDER BY n DESC`,
    )) as Array<{ stage: string; n: number }>;
    if (rows.length > 0) {
      const found = rows.map((r) => `${r.stage} ${r.n}건`).join(' · ');
      throw new Error(
        `CPL.stage 에 약속되지 않은 낱말이 있습니다 — ${found}. `
        + '어느 단계로 읽어야 하는지는 사람이 정합니다 (추정 이관 금지 · N-25). '
        + "고친 뒤 다시 실행하세요: UPDATE cpl SET stage='closed' WHERE stage='...';",
      );
    }
    await q.query(
      `ALTER TABLE cpl ADD CONSTRAINT cpl_stage_words
         CHECK (stage IN ('received','acting','closed'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE cpl DROP CONSTRAINT IF EXISTS cpl_stage_words`);
  }
}
