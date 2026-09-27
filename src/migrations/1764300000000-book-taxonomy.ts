/** @file-guide
 * 목적: 1764300000000-book-taxonomy.ts — BookTaxonomy1764300000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §39 교재 **두 층 분류** — 과목(`book_subject`) → 소분류(`book_category`) 코드표와 LIB 의 새 칸 (N-47 채택 · W11).
 *
 * - 과목 넷 · 소분류는 **원문 §39 컷에 보이는 것만** 넣는다: English(Reading · ELA · Grammar · Speaking & Interview · Writing) ·
 *   Math(General Math · Pre-Algebra) · Science(Biology) · Social Studies(컷에서 머리 줄이 잘려 소분류가 안 보인다 → 넣지 않는다).
 *   색은 컷의 칩 점 · 묶음 머리 색 그대로다. 컷에 안 보이는 소분류는 짓지 않는다.
 * - `SUB`(시간표 과목 축)는 **건드리지 않는다** — 캘린더 · 청구 색이 따라 움직이지 않게. `lib.sub_key` 도 그대로다.
 * - LIB 새 칸: 과목 · 소분류 · 레벨(Foundation/Practice/Master) · 학년 범위 두 칸(K=0 · G1~G12) · 시험 태그(SAT · MAP · ISEE / SSAT).
 *   옛 칸 `lib.level` · `lib.grade` 에는 CHECK 를 걸지 않고 값도 옮기지 않는다(N-25 · 보정 0) — 옛 교재는 새 칸이 모두 NULL
 *   (「미분류」 묶음)로 시작하고 사람이 편집 창에서 분류한다.
 * - 소분류는 **고른 과목의 것**이어야 한다 — `(book_subject_key, book_category_key)` 두 칸 FK 가 막는다.
 *   소분류만 있고 과목이 없는 줄은 FK 가 보지 않으므로(MATCH SIMPLE) `lib_book_category_needs_subject` 가 따로 막는다.
 * - 학년 범위는 두 칸이 **함께 비거나 함께 찬다**. 한 칸만 찬 줄은 비교가 NULL 이 되어 CHECK 를 빠져나가므로
 *   `IS NOT NULL` 을 먼저 적는다(`lib_grade_range`).
 *
 * `down` 은 새 칸과 코드표를 지운다 — 그 사이 사람이 매긴 분류도 함께 사라진다(옛 칸은 처음부터 그대로라 잃는 옛 값은 없다).
 */
export class BookTaxonomy1764300000000 implements MigrationInterface {
  name = 'BookTaxonomy1764300000000';

  /** [키, 이름(원문 그대로), 색(컷 실측), 차례] */
  private static readonly SUBJECTS: ReadonlyArray<readonly [string, string, string, number]> = [
    ['english', 'English', '#2563EB', 1],
    ['math', 'Math', '#DC2626', 2],
    ['science', 'Science', '#16A34A', 3],
    ['social_studies', 'Social Studies', '#D97706', 4],
  ];

  /** [키, 과목, 이름(원문 그대로), 차례] — 묶음 머리 줄에 보이는 차례 그대로 */
  private static readonly CATEGORIES: ReadonlyArray<readonly [string, string, string, number]> = [
    ['reading', 'english', 'Reading', 1],
    ['ela', 'english', 'ELA', 2],
    ['grammar', 'english', 'Grammar', 3],
    ['speaking_interview', 'english', 'Speaking & Interview', 4],
    ['writing', 'english', 'Writing', 5],
    ['general_math', 'math', 'General Math', 1],
    ['pre_algebra', 'math', 'Pre-Algebra', 2],
    ['biology', 'science', 'Biology', 1],
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE "book_subject" (
      "key"   varchar(20) PRIMARY KEY,
      "name"  varchar(40) NOT NULL,
      "color" char(7)     NOT NULL,
      "sort"  smallint    NOT NULL,
      CONSTRAINT "book_subject_color_hex" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$')
    )`);
    await q.query(`CREATE TABLE "book_category" (
      "key"         varchar(30) PRIMARY KEY,
      "subject_key" varchar(20) NOT NULL REFERENCES "book_subject"("key"),
      "name"        varchar(40) NOT NULL,
      "sort"        smallint    NOT NULL,
      CONSTRAINT "book_category_subject_uq" UNIQUE ("subject_key", "key")
    )`);
    for (const [key, name, color, sort] of BookTaxonomy1764300000000.SUBJECTS) {
      await q.query(`INSERT INTO "book_subject" ("key","name","color","sort") VALUES ($1,$2,$3,$4)`, [key, name, color, sort]);
    }
    for (const [key, subject, name, sort] of BookTaxonomy1764300000000.CATEGORIES) {
      await q.query(
        `INSERT INTO "book_category" ("key","subject_key","name","sort") VALUES ($1,$2,$3,$4)`, [key, subject, name, sort],
      );
    }

    await q.query(`ALTER TABLE "lib"
      ADD COLUMN "book_subject_key"  varchar(20),
      ADD COLUMN "book_category_key" varchar(30),
      ADD COLUMN "book_level"        varchar(12),
      ADD COLUMN "grade_from"        smallint,
      ADD COLUMN "grade_to"          smallint,
      ADD COLUMN "exam_tag"          varchar(12)`);
    await q.query(`ALTER TABLE "lib"
      ADD CONSTRAINT "lib_book_subject_fk" FOREIGN KEY ("book_subject_key") REFERENCES "book_subject"("key"),
      ADD CONSTRAINT "lib_book_category_fk" FOREIGN KEY ("book_subject_key", "book_category_key")
        REFERENCES "book_category"("subject_key", "key")`);
    // CHECK 는 문장마다 하나 — `migration:dryrun` 이 걸린 행을 셀 때 문장에서 식을 읽는다(lib/sql parseCheckConstraint · sql.spec)
    await q.query(`ALTER TABLE "lib" ADD CONSTRAINT "lib_book_category_needs_subject"
      CHECK ("book_category_key" IS NULL OR "book_subject_key" IS NOT NULL)`);
    await q.query(`ALTER TABLE "lib" ADD CONSTRAINT "lib_book_level_words"
      CHECK ("book_level" IS NULL OR "book_level" IN ('foundation','practice','master'))`);
    await q.query(`ALTER TABLE "lib" ADD CONSTRAINT "lib_grade_range" CHECK (
        ("grade_from" IS NULL AND "grade_to" IS NULL)
        OR ("grade_from" IS NOT NULL AND "grade_to" IS NOT NULL
            AND "grade_from" BETWEEN 0 AND 12 AND "grade_to" BETWEEN 0 AND 12 AND "grade_from" <= "grade_to")
      )`);
    await q.query(`ALTER TABLE "lib" ADD CONSTRAINT "lib_exam_tag_words"
      CHECK ("exam_tag" IS NULL OR "exam_tag" IN ('sat','map','isee_ssat'))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lib"
      DROP CONSTRAINT IF EXISTS "lib_exam_tag_words",
      DROP CONSTRAINT IF EXISTS "lib_grade_range",
      DROP CONSTRAINT IF EXISTS "lib_book_level_words",
      DROP CONSTRAINT IF EXISTS "lib_book_category_needs_subject",
      DROP CONSTRAINT IF EXISTS "lib_book_category_fk",
      DROP CONSTRAINT IF EXISTS "lib_book_subject_fk"`);
    await q.query(`ALTER TABLE "lib"
      DROP COLUMN IF EXISTS "exam_tag",
      DROP COLUMN IF EXISTS "grade_to",
      DROP COLUMN IF EXISTS "grade_from",
      DROP COLUMN IF EXISTS "book_level",
      DROP COLUMN IF EXISTS "book_category_key",
      DROP COLUMN IF EXISTS "book_subject_key"`);
    await q.query(`DROP TABLE IF EXISTS "book_category"`);
    await q.query(`DROP TABLE IF EXISTS "book_subject"`);
  }
}
