/** @file-guide
 * 목적: 1759200000000-meeting-minutes-author.ts — MeetingMinutesAuthor1759200000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §66 회의 상세 — 속기록에 **누가 언제 저장했는지**를 남긴다 (C57).
 *
 * 원문 §66 컷의 속기록 칸 바로 아래에 「**마지막 저장 2026-08-20 14:20 · 김민선**」이 있다.
 * 그런데 `MTREC` 에는 `minutes` 본문 한 칸뿐이라, 누가 마지막으로 고쳤는지 알 방법이 없다.
 * 속기록은 「정한 것」이 적히는 자리다 — 나중에 「그건 누가 적었나」를 물을 때 답이 없으면
 * 회의록이 아니라 낙서가 된다.
 *
 * `created_at` 으로 대신하지 않는다. 그것은 **회의 행이 생긴 시각**이지 속기록을 쓴 시각이
 * 아니다. 둘을 같은 것으로 쓰면 나중에 고친 속기록이 처음 적은 것처럼 보인다.
 *
 * 기존 행은 **건드리지 않는다.** 이미 `minutes` 가 차 있는 회의가 둘 있지만 누가 썼는지
 * 알 방법이 없다 — 아무나 적어 넣으면 원장이 거짓이 된다. 「모른다」로 남는 쪽이 맞다.
 */
export class MeetingMinutesAuthor1759200000000 implements MigrationInterface {
  name = 'MeetingMinutesAuthor1759200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mtrec ADD COLUMN IF NOT EXISTS minutes_at timestamptz`);
    await q.query(
      `COMMENT ON COLUMN mtrec.minutes_at IS '속기록을 마지막으로 저장한 시각 — created_at(회의 행이 생긴 시각)과 다르다 (원문 §66)'`,
    );
    await q.query(`ALTER TABLE mtrec ADD COLUMN IF NOT EXISTS minutes_by bigint`);
    await q.query(
      `COMMENT ON COLUMN mtrec.minutes_by IS '속기록을 마지막으로 저장한 사람 — 「그건 누가 적었나」의 답'`,
    );
    // 둘은 함께 있거나 함께 없다. 한쪽만 남으면 「저장은 됐는데 누가 했는지 모른다」가 된다.
    await q.query(
      `ALTER TABLE mtrec ADD CONSTRAINT mtrec_minutes_author_pair
         CHECK ((minutes_at IS NULL) = (minutes_by IS NULL)) NOT VALID`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mtrec DROP CONSTRAINT IF EXISTS mtrec_minutes_author_pair`);
    await q.query(`ALTER TABLE mtrec DROP COLUMN IF EXISTS minutes_by`);
    await q.query(`ALTER TABLE mtrec DROP COLUMN IF EXISTS minutes_at`);
  }
}
