/** @file-guide
 * 목적: 1758900000000-marketing-feedback-thread.ts — MarketingFeedbackThread1758900000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §60 대표 피드백 — MFB 를 **실이 이어지는 글타래**로 만든다 (C53).
 *
 * 원문 §60 의 규칙은 두 줄이다. 「대표 코멘트는 전원 공지, 담당자 답변은 대표에게만.」
 * 그러려면 한 줄이 **코멘트인지 답변인지**를 알아야 한다. 지금 MFB 에는 `by_id` 밖에 없어서
 * 「쓴 사람의 지금 역할」로 되짚는 수밖에 없는데, 역할은 바뀐다 — 지난달 대표가 오늘 대표가
 * 아니면 지난달 글의 종류가 조용히 바뀐다. **쓸 때의 사실을 그대로 적는다** (N-25 와 같은 이유).
 *
 * `parent_id` 도 같은 이유다. 「고쳤습니다 / 확인 필요」는 원문 §60 카드의 칩인데, 이것을
 * 시각 비교(코멘트보다 나중에 쓴 글이 있으면 답)로 만들면 **판정이 두 곳에 살게 된다.**
 * 답변은 자기가 어느 코멘트에 대한 답인지 들고 있는다 (D-R39).
 *
 * MKT 에 붙이는 두 칸:
 * - `title`  — 원문 §59·§60 카드의 이름표다. 지금은 채널·항목 코드밖에 없어서 카드를
 *              「instagram · ad」라고 부를 수밖에 없다.
 * - `by_id`  — 원문 §59 카드마다 담당자 이름이 붙는다. 「담당자 답변」의 담당자가 이 사람이다.
 *
 * 기존 행은 **건드리지 않는다.** 이미 있는 MFB 행이 코멘트였는지 답변이었는지 알 방법이 없다.
 * 기본값 `comment` 는 새로 들어오는 행에 붙는 것이고, 옛 행을 추정해서 나누지 않는다.
 */
export class MarketingFeedbackThread1758900000000 implements MigrationInterface {
  name = 'MarketingFeedbackThread1758900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mkt ADD COLUMN IF NOT EXISTS title varchar(120)`);
    await q.query(
      `COMMENT ON COLUMN mkt.title IS '활동 이름 — 원문 §59·§60 카드의 제목. 없으면 채널·항목으로 부른다'`,
    );
    await q.query(`ALTER TABLE mkt ADD COLUMN IF NOT EXISTS by_id bigint`);
    await q.query(
      `COMMENT ON COLUMN mkt.by_id IS '담당자 — 원문 §60 「담당자 답변」을 쓸 수 있는 사람'`,
    );

    await q.query(`ALTER TABLE mfb ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'comment'`);
    await q.query(
      `COMMENT ON COLUMN mfb.kind IS '쓸 때의 종류 — comment(대표 코멘트) · reply(담당자 답변). 역할로 되짚지 않는다'`,
    );
    await q.query(`ALTER TABLE mfb ADD COLUMN IF NOT EXISTS parent_id bigint`);
    await q.query(
      `COMMENT ON COLUMN mfb.parent_id IS '답변이 답하는 코멘트 — 「고쳤습니다」 판정의 근거. 코멘트면 NULL'`,
    );

    await q.query(
      `ALTER TABLE mfb ADD CONSTRAINT mfb_kind_chk CHECK (kind IN ('comment','reply')) NOT VALID`,
    );
    // 답변은 반드시 어느 코멘트에 대한 답인지 들고 있고, 코멘트는 부모가 없다.
    // 이 칸이 없던 동안 쌓인 행은 전부 kind='comment' · parent_id IS NULL 이라 이 검사를 통과한다.
    await q.query(
      `ALTER TABLE mfb ADD CONSTRAINT mfb_reply_needs_parent
         CHECK ((kind = 'reply') = (parent_id IS NOT NULL)) NOT VALID`,
    );
    await q.query(`CREATE INDEX IF NOT EXISTS mfb_mkt_id_at_idx ON mfb (mkt_id, at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS mfb_parent_id_idx ON mfb (parent_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS mfb_parent_id_idx`);
    await q.query(`DROP INDEX IF EXISTS mfb_mkt_id_at_idx`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_reply_needs_parent`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_kind_chk`);
    await q.query(`ALTER TABLE mfb DROP COLUMN IF EXISTS parent_id`);
    await q.query(`ALTER TABLE mfb DROP COLUMN IF EXISTS kind`);
    await q.query(`ALTER TABLE mkt DROP COLUMN IF EXISTS by_id`);
    await q.query(`ALTER TABLE mkt DROP COLUMN IF EXISTS title`);
  }
}
