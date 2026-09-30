/** @file-guide
 * 목적: 컨설팅 항목(CONS_ITEM)에 기한 칸 하나를 새긴다 (테스트 시나리오 I-94 「기한이 있으면 D-day 표시」).
 * 책임/재사용: 새 칸만 더한다 — 옛 행은 NULL(기한 없음 · N-25). D-day 낱말은 저장하지 않고 서버가 오늘(KST)로 계산한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * I-94 「② 항목 하나 완료 체크 · 파일 첨부 — 완료 시 빗금 + 완료 시각·담당자 · 기한이 있으면 D-day 표시」.
 * 원문 §31 항목 줄에는 기한 입력이 없어 화면이 「기한 없음」이라 적어 왔다. 사용자 지시(2026-09-30 「부분 구현 · 권고안으로 진행」)로
 * 「항목 수정」이 기한을 적고 지우게 한다.
 *
 * - `due_on date` NULL 허용 — 기한 없는 항목이 기본이다. 옛 행은 NULL 그대로(추정해 채우지 않는다 · N-25).
 * - D-day(「D-3」 · 「D-day」 · 「D+2」)와 지남은 **저장하지 않는다** — 날마다 바뀌는 값이라 읽을 때 서버가 오늘(KST)로 센다.
 * - down 은 채워진 행이 있으면 멈춘다 — 칸을 버리면 적어 둔 기한이 사라진다.
 */
export class ConsItemDue1765500000000 implements MigrationInterface {
  name = 'ConsItemDue1765500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cons_item" ADD COLUMN "due_on" date`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "cons_item" WHERE "due_on" IS NOT NULL) THEN
        RAISE EXCEPTION 'ConsItemDue down would discard stored item due dates';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE "cons_item" DROP COLUMN "due_on"`);
  }
}
