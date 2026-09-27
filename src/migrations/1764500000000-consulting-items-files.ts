/** @file-guide
 * 목적: 1764500000000-consulting-items-files.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/** 지금 쓰는 낱말 — `up` 이 새기는 집합이자 `down` 이 되돌릴 기준이다 (1761900000000 과 같은 모양) */
const EVENT_BEFORE = [
  'created', 'share_changed', 'file_added', 'file_removed', 'feedback_added',
  'feedback_resolved', 'parent_delivered', 'payment_added', 'archived',
  'session_added', 'session_written', 'closed', 'item_done', 'item_undone',
] as const;
const EVENT_ADDED = ['item_added', 'item_renamed', 'item_removed'] as const;

const eventCheck = (words: readonly string[]): string =>
  `CHECK ("event_type" IN (${words.map((w) => `'${w}'`).join(',')}))`;

/** 1759900000000 이 만든 그대로 — `down` 이 되돌릴 모양 */
const GUARD_BEFORE = `CREATE OR REPLACE FUNCTION cons_file_limit_guard() RETURNS trigger AS $$
      BEGIN
        PERFORM 1 FROM cons WHERE id=NEW.cons_id FOR UPDATE;
        IF (SELECT count(*) FROM cons_file WHERE cons_id=NEW.cons_id) >= 10 THEN
          RAISE EXCEPTION 'contract files are limited to 10'
            USING ERRCODE='23514', CONSTRAINT='cons_file_limit';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`;

/**
 * 계약 파일 10개와 **따로** 센다 — 항목 파일은 항목마다 6개(N-63). 항목은 같은 컨설팅의 것이어야 한다.
 * 부모(cons) 줄을 먼저 잠그는 것은 그대로다 — 같은 건의 두 업로드가 엇갈려 한도를 넘지 않게.
 */
const GUARD_AFTER = `CREATE OR REPLACE FUNCTION cons_file_limit_guard() RETURNS trigger AS $$
      BEGIN
        PERFORM 1 FROM cons WHERE id=NEW.cons_id FOR UPDATE;
        IF NEW.item_id IS NULL THEN
          IF (SELECT count(*) FROM cons_file WHERE cons_id=NEW.cons_id AND item_id IS NULL) >= 10 THEN
            RAISE EXCEPTION 'contract files are limited to 10'
              USING ERRCODE='23514', CONSTRAINT='cons_file_limit';
          END IF;
        ELSE
          IF NOT EXISTS (SELECT 1 FROM cons_item WHERE id=NEW.item_id AND cons_id=NEW.cons_id) THEN
            RAISE EXCEPTION 'item file must belong to the same consulting'
              USING ERRCODE='23514', CONSTRAINT='cons_file_item_cons';
          END IF;
          IF (SELECT count(*) FROM cons_file WHERE item_id=NEW.item_id) >= 6 THEN
            RAISE EXCEPTION 'item files are limited to 6'
              USING ERRCODE='23514', CONSTRAINT='cons_file_item_limit';
          END IF;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`;

/**
 * 컨설팅 항목 수정 · 항목 파일 — W11 결정 채택 (N-18-a 부분 · N-63).
 *
 * ① `cons_file.item_id` (nullable · FK `cons_item`) — 항목마다 파일(원문 §31 항목 줄의 「파일」). 같은 표 · 같은 업로드 · 같은 권한 판정을 쓴다.
 *    `role` 낱말에 `item` 을 더하고 **짝 CHECK** 로 「item 이면 item_id 가 있고, 아니면 없다」를 묶는다.
 *    한도 트리거는 계약 파일(item_id 없음) 10개와 항목마다 6개를 **따로** 센다 — 전에는 건 전체를 10개로 셌다.
 * ② `cons_event.event_type` 낱말 +3 — `item_added` · `item_renamed` · `item_removed` (원문 §31 「항목 수정」 · 담당이 더하기 · 이름 바꾸기 · 빼기).
 *    켬·끔(`item_done` · `item_undone`)과 같은 원장에 남긴다 — 「이 건에 누가 무엇을 했나」가 두 표로 갈리지 않게(1761900000000 과 같은 판단).
 *
 * **기존 행 보정 0** (N-25) — 옛 파일은 전부 계약 파일(item_id NULL)이고 짝 CHECK 를 이미 만족한다.
 */
export class ConsultingItemsFiles1764500000000 implements MigrationInterface {
  name = 'ConsultingItemsFiles1764500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cons_file" ADD COLUMN "item_id" bigint`);
    await q.query(`ALTER TABLE "cons_file" ADD CONSTRAINT "cons_file_item_fk" FOREIGN KEY ("item_id") REFERENCES "cons_item"("id")`);
    await q.query(`ALTER TABLE "cons_file" DROP CONSTRAINT IF EXISTS "cons_file_role_check"`);
    await q.query(`ALTER TABLE "cons_file" ADD CONSTRAINT "cons_file_role_check" CHECK ("role" IN ('draft','revision','signed','item'))`);
    await q.query(`ALTER TABLE "cons_file" ADD CONSTRAINT "cons_file_item_pair_check" CHECK (("role" = 'item') = ("item_id" IS NOT NULL))`);
    await q.query(`CREATE INDEX "cons_file_item_idx" ON "cons_file" ("item_id", "created_at", "file_id") WHERE "item_id" IS NOT NULL`);
    await q.query(GUARD_AFTER);

    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`ALTER TABLE "cons_event" ADD CONSTRAINT "cons_event_type_check" ${eventCheck([...EVENT_BEFORE, ...EVENT_ADDED])}`);
  }

  /**
   * 되돌리기는 **좁히는 일**이라 데이터를 먼저 본다 — 항목 파일이나 새 낱말 줄이 남아 있으면 멈춘다.
   * 그 줄을 지우지 않는다(파일 본문 · 감사 원장이다). **세어서 멈추고** 사람이 정한다.
   */
  public async down(q: QueryRunner): Promise<void> {
    const [{ files }] = (await q.query(
      `SELECT count(*)::int AS files FROM "cons_file" WHERE "item_id" IS NOT NULL`,
    )) as Array<{ files: number }>;
    const [{ events }] = (await q.query(
      `SELECT count(*)::int AS events FROM "cons_event" WHERE "event_type" = ANY($1::text[])`, [[...EVENT_ADDED]],
    )) as Array<{ events: number }>;
    if (Number(files) > 0 || Number(events) > 0) {
      throw new Error(
        `항목 파일 ${files}건 · 항목 수정 기록(${EVENT_ADDED.join('·')}) ${events}건이 남아 있어 되돌릴 수 없습니다 — ` +
        '그 줄을 어떻게 할지(보존·이관·삭제) 정한 뒤 다시 내리세요.',
      );
    }
    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`ALTER TABLE "cons_event" ADD CONSTRAINT "cons_event_type_check" ${eventCheck(EVENT_BEFORE)}`);

    await q.query(GUARD_BEFORE);
    await q.query(`DROP INDEX IF EXISTS "cons_file_item_idx"`);
    await q.query(`ALTER TABLE "cons_file" DROP CONSTRAINT IF EXISTS "cons_file_item_pair_check"`);
    await q.query(`ALTER TABLE "cons_file" DROP CONSTRAINT IF EXISTS "cons_file_role_check"`);
    await q.query(`ALTER TABLE "cons_file" ADD CONSTRAINT "cons_file_role_check" CHECK ("role" IN ('draft','revision','signed'))`);
    await q.query(`ALTER TABLE "cons_file" DROP CONSTRAINT IF EXISTS "cons_file_item_fk"`);
    await q.query(`ALTER TABLE "cons_file" DROP COLUMN IF EXISTS "item_id"`);
  }
}
