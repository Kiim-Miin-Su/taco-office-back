/** @file-guide
 * 목적: 1761700000000-plan-stage-flow.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 기획 보완 요청 사유를 **행에** · `PLAN.stage` 낱말을 굳힌다 — S6 (전수 검수 §5).
 *
 * ① **`rework_reason`** — 보완 요청 사유가 `log.after->>'reason'` 에만 들어가고 `plan` 에도
 *    DTO 에도 칸이 없어 **담당자가 왜 반려됐는지 볼 방법이 없었다.** 감사 줄에서 되짚지 않는다:
 *    사유는 **다시 올릴 때 지워지는 업무 상태**이고 `log` 는 지워지지 않는 감사 줄이다.
 *    「가장 최근 rework 줄, 단 그보다 뒤에 submit 줄이 없을 때」를 매번 되짚는 것은 판정을
 *    하나 더 만드는 일이고, `log.after` 의 생김새는 계약이 아니라서 감사 줄의 모양을 바꾸면
 *    담당자 화면이 **조용히 빈다**. 기존 행 보정 **0** (N-25) — 지금 `rework` 인 건이 왜
 *    반려됐는지는 아무도 모른다.
 *
 * ② **`plan_stage_words`** — C86-d 와 같은 자리다. `erd.dbml` 의 note 와 `plan.entity.ts`
 *    주석이 **둘 다** 「draft | review | rework | ok | done」이라 선언하는데, 마이그레이션
 *    `1756700000000` 이 이미 `ok`·`done` 을 `approved` 로 접었고 코드가 쓰는 낱말은 `approved` 다.
 *    **선언과 데이터가 다르면 그 차이를 읽은 쪽이 조용히 틀린다** — 컴플레인에서 대표 보고 배지가
 *    8(실제 5)이었던 그 모양이다. 아직 PLAN 에는 그런 코드가 없지만 **S6 이 `done` 에 처음으로
 *    쓰는 길을 내므로** 굳히는 것은 지금이다. 표에 제약은 하나도 없었다.
 *
 * 기존 행은 보정하지 않는다. 다른 낱말이 있으면 **세어서 멈춘다** — 어느 단계로 읽을지는 사람이 정한다.
 */
export class PlanStageFlow1761700000000 implements MigrationInterface {
  name = 'PlanStageFlow1761700000000';

  /** `lib/plan-words.ts` 의 `PLAN_STAGES` 와 같은 다섯 — 낱말이 바뀌면 둘 다 고친다 */
  private static readonly STAGES = ['draft', 'review', 'rework', 'approved', 'done'];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "plan" ADD COLUMN "rework_reason" text`);

    const list = PlanStageFlow1761700000000.STAGES.map((s) => `'${s}'`).join(',');
    const rows = (await q.query(
      `SELECT stage, count(*)::int AS n FROM plan
        WHERE stage IS NULL OR stage NOT IN (${list})
        GROUP BY stage ORDER BY n DESC`,
    )) as Array<{ stage: string | null; n: number }>;
    if (rows.length > 0) {
      const found = rows.map((r) => `${r.stage ?? 'NULL'} ${r.n}건`).join(' · ');
      throw new Error(
        `PLAN.stage 에 약속되지 않은 낱말이 있습니다 — ${found}. `
        + '어느 단계로 읽어야 하는지는 사람이 정합니다 (추정 이관 금지 · N-25). '
        + "고친 뒤 다시 실행하세요: UPDATE plan SET stage='approved' WHERE stage='...';",
      );
    }
    await q.query(
      `ALTER TABLE "plan" ADD CONSTRAINT "plan_stage_words" CHECK ("stage" IN (${list})) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "plan" DROP CONSTRAINT IF EXISTS "plan_stage_words"`);
    await q.query(`ALTER TABLE "plan" DROP COLUMN IF EXISTS "rework_reason"`);
  }
}
