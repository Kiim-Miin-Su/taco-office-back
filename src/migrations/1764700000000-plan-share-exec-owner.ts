/** @file-guide
 * 목적: 1764700000000-plan-share-exec-owner.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W11 운영 · 대표 보고 — 결정 셋의 저장 자리 (N-72 · N-95 · N-81 · 2026-09-26).
 *
 * ① **기획 공개 범위** (N-72 · 원문 §61 카드의 「전체 공개」 · 「지정 공개」 칩).
 *    `plan.share` 는 원문 두 값(`all` · `picked`)만 받는다. **옛 기획은 NULL 그대로** — 지금처럼 모두에게
 *    보이고 칩이 서지 않는다(N-25 · 보정 0). 누가 지정됐는지는 새 표 `plan_pick` 이 갖는다(컨설팅 `cons_pick` 과
 *    같은 모양). 기획이 지워지면 지정도 같이 사라진다(CASCADE) — 지정은 그 기획의 일부다.
 *
 * ② **기한 반려 보존** (N-95 · 원문 §61 「보완 요청」 카드의 「D-2 08-19 · 기한 반려」).
 *    반려는 `due_on` 을 지운다(C56 — 반려된 날짜는 더 이상 마감이 아니다 · §62 표에는 원문대로 그 날짜로 서되
 *    지난 기한으로 세지 않는다 · W11 재대조). 그래서 **무엇이 언제
 *    누구에게 반려됐는지**를 세 칸에 둔다. 셋은 함께 있거나 함께 없고(`plan_due_rejected_triple`), 담당이 새 기한을
 *    내면 비운다 — 새 기한과 반려 표시가 한 카드에 같이 서지 않게 표가 막는다(`plan_due_rejected_clears`).
 *    옛 반려는 기록이 없어 NULL 그대로다(N-25 — 지어내지 않는다).
 *
 * ③ **대표 보고 영역 담당** (N-81 · 원문 §69 카드 메모 칸 위의 담당 이름 · 슬라이드 72 표).
 *    영역마다 고정 담당 한 명 — 여섯 영역 키만 받고(CHECK), 사람을 지우면 담당이 비고(SET NULL) 행은 남는다.
 *    **처음엔 비어 있다** — 원문 표본 이름(Grace · 김범준)을 데이터로 넣지 않는다. 대표가 화면에서 고른다.
 *
 * down 은 이 셋이 만든 값(공개 범위 · 지정 · 반려 기록 · 영역 담당)을 **지운다** — 모두 이 migration 이후에만
 * 생기는 값이라 옛 데이터는 잃지 않는다. 되돌리기 전에 그 값들이 필요 없는지 확인한다.
 */
export class PlanShareExecOwner1764700000000 implements MigrationInterface {
  name = 'PlanShareExecOwner1764700000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ① 기획 공개 범위 */
    await q.query(`ALTER TABLE plan ADD COLUMN share varchar(10)`);
    await q.query(
      `COMMENT ON COLUMN plan.share IS '공개 범위 — all 전체 공개 · picked 지정 공개(담당·지정된 사람·결재권자). NULL = 옛 기획 — 모두에게 보이고 칩 없음 (N-72)'`,
    );
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_share_words CHECK (share IS NULL OR share IN ('all', 'picked'))`,
    );
    await q.query(`
      CREATE TABLE plan_pick (
        plan_id bigint NOT NULL,
        staff_id bigint NOT NULL,
        CONSTRAINT plan_pick_pkey PRIMARY KEY (plan_id, staff_id),
        CONSTRAINT plan_pick_plan_fk FOREIGN KEY (plan_id) REFERENCES plan(id) ON DELETE CASCADE,
        CONSTRAINT plan_pick_staff_fk FOREIGN KEY (staff_id) REFERENCES staff(id)
      )`);
    await q.query(`COMMENT ON TABLE plan_pick IS '지정 공개 기획을 볼 수 있게 지정된 사람 (N-72 · cons_pick 과 같은 모양)'`);

    /* ② 기한 반려 보존 */
    await q.query(`ALTER TABLE plan ADD COLUMN due_rejected_on date`);
    await q.query(`ALTER TABLE plan ADD COLUMN due_rejected_at timestamptz`);
    await q.query(`ALTER TABLE plan ADD COLUMN due_rejected_by bigint`);
    await q.query(`COMMENT ON COLUMN plan.due_rejected_on IS '반려된 기한 — 반려가 지운 due_on 의 값 (N-95)'`);
    await q.query(`COMMENT ON COLUMN plan.due_rejected_at IS '기한을 반려한 순간'`);
    await q.query(`COMMENT ON COLUMN plan.due_rejected_by IS '기한을 반려한 사람'`);
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_due_rejected_by_fk FOREIGN KEY (due_rejected_by) REFERENCES staff(id)`,
    );
    // 셋은 한 사실이다 — 한 칸만 남으면 「반려는 됐는데 무엇을 누가」를 모른다
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_due_rejected_triple
         CHECK ((due_rejected_at IS NULL) = (due_rejected_by IS NULL)
            AND (due_rejected_at IS NULL) = (due_rejected_on IS NULL))`,
    );
    // 새 기한을 내면 반려 표시는 비운다 — 한 카드에 새 기한과 「기한 반려」가 같이 서지 않는다
    await q.query(
      `ALTER TABLE plan ADD CONSTRAINT plan_due_rejected_clears CHECK (due_rejected_at IS NULL OR due_on IS NULL)`,
    );

    /* ③ 대표 보고 영역 담당 */
    await q.query(`
      CREATE TABLE exec_area_owner (
        area_key varchar(12) NOT NULL,
        staff_id bigint,
        set_by bigint NOT NULL,
        set_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT exec_area_owner_pkey PRIMARY KEY (area_key),
        CONSTRAINT exec_area_owner_key_words
          CHECK (area_key IN ('money', 'mkt', 'ops', 'consulting', 'complaint', 'lesson')),
        CONSTRAINT exec_area_owner_staff_fk FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL,
        CONSTRAINT exec_area_owner_set_by_fk FOREIGN KEY (set_by) REFERENCES staff(id)
      )`);
    await q.query(
      `COMMENT ON TABLE exec_area_owner IS '대표 보고 영역마다 고정 담당 한 명 — 대표가 정한다. 처음엔 비어 있다 (N-81 · 원문 슬라이드 72)'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // 이 migration 이후에 생긴 값(영역 담당 · 반려 기록 · 지정 · 공개 범위)만 사라진다 — 머리 주석 참고
    await q.query(`DROP TABLE IF EXISTS exec_area_owner`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_rejected_clears`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_rejected_triple`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_due_rejected_by_fk`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS due_rejected_by`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS due_rejected_at`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS due_rejected_on`);
    await q.query(`DROP TABLE IF EXISTS plan_pick`);
    await q.query(`ALTER TABLE plan DROP CONSTRAINT IF EXISTS plan_share_words`);
    await q.query(`ALTER TABLE plan DROP COLUMN IF EXISTS share`);
  }
}
