/** @file-guide
 * 목적: §12 준비 행의 저장 정본 — 회차에 걸린 대표 지시와 줌 안내 전달 대상을 DB에 둔다.
 * 책임/재사용: 기존 행을 보정하지 않고 칸과 제약만 더한다. 판정은 서비스가, 저장은 여기가 맡는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C82-b — 원본 §12(온라인 9행)·§79(현장 7행)이 요구하는 두 가지 저장 정본.
 *
 * ① **대표 지시 할 일이 회차를 가리킬 길이 없었다.** TODO 는 회의·컴플레인·컨설팅·기획만
 *    되짚을 수 있었다. 회차 키는 `(ser_id, on_date)` 두 칸이다 — `ser_occ.id` 를 쓰지 않는
 *    이유는 그 표가 **투영**이고 `schedule.project.ts` 가 쓰기마다 그 구간을 지우고 다시
 *    넣기 때문이다(id 가 바뀌고, FK 를 걸면 그 DELETE 가 막힌다). `on_date` 는 규칙이 원래
 *    찍은 날 — EXC 의 키와 같아서 옮긴 회차도 따라간다.
 *
 * ② **줌 안내를 누구에게 보냈는지 적을 칸이 없었다.** 원본 §43 「매번」은 줄마다 「학부모」와
 *    「강사」 체크가 **따로** 있다. 표를 새로 파지 않고 PNOTI 에 대상 축을 더한다.
 *    기존 행은 전부 `parent` 다 — 그 표의 정의가 「학부모 안내」이고 `student_id` 가
 *    NOT NULL 이라 다른 값일 수 없다. **추정 이관이 아니다** (N-25).
 *
 * 두 CHECK 는 `NOT VALID` 로 건다 — 새 행만 지키고 기존 행을 검사하지 않는다 (C64 선례).
 */
export class LessonPrepSsot1760100000000 implements MigrationInterface {
  name = 'LessonPrepSsot1760100000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ── ① 회차에 걸리는 대표 지시 ─────────────────────────────── */
    await q.query(`ALTER TYPE todo_src_t ADD VALUE IF NOT EXISTS 'lesson'`);
    await q.query(`ALTER TABLE todo ADD COLUMN ser_id bigint REFERENCES ser(id) ON DELETE SET NULL`);
    await q.query(`ALTER TABLE todo ADD COLUMN on_date date`);
    await q.query(`CREATE INDEX todo_lesson_idx ON todo (ser_id, on_date) WHERE ser_id IS NOT NULL`);
    // 회차 지시는 두 칸이 함께 있어야 한다 — 한 칸만으로는 어느 회차인지 못 짚는다
    await q.query(`ALTER TABLE todo ADD CONSTRAINT todo_lesson_key
      CHECK ((ser_id IS NULL) = (on_date IS NULL)) NOT VALID`);

    /* ── ② 줌 안내 전달 대상 ───────────────────────────────────── */
    await q.query(`CREATE TYPE pnoti_audience_t AS ENUM ('parent', 'teacher')`);
    await q.query(`ALTER TABLE pnoti ADD COLUMN audience pnoti_audience_t NOT NULL DEFAULT 'parent'`);
    await q.query(`ALTER TABLE pnoti ADD COLUMN staff_id bigint REFERENCES staff(id) ON DELETE CASCADE`);
    await q.query(`ALTER TABLE pnoti ALTER COLUMN student_id DROP NOT NULL`);
    // 학부모 행은 학생을, 강사 행은 강사를 가리킨다 — 둘 다이거나 둘 다 아닌 행은 없다
    await q.query(`ALTER TABLE pnoti ADD CONSTRAINT pnoti_audience_target CHECK (
      (audience = 'parent'  AND student_id IS NOT NULL AND staff_id IS NULL) OR
      (audience = 'teacher' AND staff_id   IS NOT NULL AND student_id IS NULL)
    ) NOT VALID`);
    // 강사에게는 회차마다 한 번이다 — 두 번 보내 두 줄이 남지 않게 한다
    await q.query(`CREATE UNIQUE INDEX pnoti_teacher_once
      ON pnoti (ser_id, on_date, staff_id) WHERE audience = 'teacher'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS pnoti_teacher_once`);
    await q.query(`ALTER TABLE pnoti DROP CONSTRAINT IF EXISTS pnoti_audience_target`);
    await q.query(`ALTER TABLE pnoti DROP COLUMN IF EXISTS staff_id`);
    await q.query(`ALTER TABLE pnoti DROP COLUMN IF EXISTS audience`);
    await q.query(`DROP TYPE IF EXISTS pnoti_audience_t`);
    // student_id 를 다시 NOT NULL 로 올리지 않는다 — 내려온 사이에 강사 행이 생겼으면 깨진다
    await q.query(`ALTER TABLE todo DROP CONSTRAINT IF EXISTS todo_lesson_key`);
    await q.query(`DROP INDEX IF EXISTS todo_lesson_idx`);
    await q.query(`ALTER TABLE todo DROP COLUMN IF EXISTS on_date`);
    await q.query(`ALTER TABLE todo DROP COLUMN IF EXISTS ser_id`);
    // todo_src_t 의 'lesson' 은 되돌리지 않는다 — PostgreSQL 은 enum 값을 지우지 못한다
  }
}
