/** @file-guide
 * 목적: 1764330000000-issue-form.ts — IssueForm1764330000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 배부 형태 `issue.form` — §38 트래킹 교재 칸 아래 칩 「PDF」 · 「실물 책」 (7-3 §38-2 · 리드 채택 2026-09-27 · 권고 (가)).
 *
 * 원문 §38 컷은 칩을 교재(LIB)가 아니라 **배부 줄**에 붙인다 — 서가 §39 카드에는 형태 칩이 없고, 「승인 대기」 요청만 있는
 * 학생(이유찬 「실물 책」 · 이하린 「PDF」)에게도 선다. 그래서 칸은 `issue` 에 둔다(배부 창에서 고른다 · 선택).
 *
 * - `pdf | print` 두 값 CHECK · NULL 허용 — 옛 배부 줄은 NULL = 칩 없음(형태를 짐작해 채우지 않는다 · 보정 0).
 * - 낱말(「PDF」 · 「실물 책」)은 lib/book 한 곳이다. CHECK 는 문장마다 하나(`migration:dryrun` 이 문장에서 식을 읽는다).
 *
 * `down` 은 칸을 지운다 — 그 사이 고른 형태도 함께 사라진다.
 */
export class IssueForm1764330000000 implements MigrationInterface {
  name = 'IssueForm1764330000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issue" ADD COLUMN "form" varchar(8)`);
    await q.query(`ALTER TABLE "issue" ADD CONSTRAINT "issue_form_words" CHECK ("form" IS NULL OR "form" IN ('pdf','print'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issue" DROP CONSTRAINT IF EXISTS "issue_form_words"`);
    await q.query(`ALTER TABLE "issue" DROP COLUMN IF EXISTS "form"`);
  }
}
