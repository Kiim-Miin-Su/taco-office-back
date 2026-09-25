/** @file-guide
 * 목적: 1762900000000-noti-title.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §16 알림 카드의 **굵은 제목** `NOTI.title` — g2 대조 16-1.
 *
 * 원문 §16 카드는 「굵은 제목 + 상세 한 줄 + 메타」인데 `NOTI` 는 `body` 한 칸이라 제목과 상세를 가를 수 없었다.
 * 본문 글자를 잘라 제목을 짐작하지 않는다(글자는 사람이 바꾼다) — 쓰는 쪽이 제목을 **따로 적는 칸**을 둔다.
 *
 * - nullable · 제약 없음. **옛 행 보정 0**(N-25) — 그때 무엇이 제목이었는지 아무도 모른다. 화면은 NULL 이면 본문을 한 줄로 그린다.
 * - 길이 80 — 같은 표의 `link` 와 같은 폭이고, 원문 제목(「MAP Reading 리포트 독촉」 등)은 한 줄에 든다.
 * - 제목을 적는 쓰기는 서랍의 두 결재 결과(요청 승인·반려 · 변경 요청 반영·반려)부터다. 나머지 알림 쓰기는 NULL 그대로다.
 */
export class NotiTitle1762900000000 implements MigrationInterface {
  name = 'NotiTitle1762900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "noti" ADD COLUMN IF NOT EXISTS "title" varchar(80)`);
  }

  /** 되돌리면 적힌 제목이 함께 사라진다 — 본문은 그대로라 알림 자체는 잃지 않는다 */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "noti" DROP COLUMN IF EXISTS "title"`);
  }
}
