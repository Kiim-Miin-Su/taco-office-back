/** @file-guide
 * 목적: 1763200000000-tzg-seoul-name.ts — TzgSeoulName1763200000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 시간대 그룹 `Asia/Seoul` 의 이름을 원문 §17 낱말 **「서울」** 로 (g2 대조 17-1 · D-R44).
 *
 * 원문 §17 은 머리 문장을 「관리자 화면은 **서울 KST 고정**입니다」라 적고, 줄마다 시간대를
 * 「서울 · 미국 동부 · 영국 · 시드니」로 적는다. 우리는 「한국 (KST)」이라 적고 있었다 —
 * 화면은 이 행의 `name` 을 그대로 읽으므로(서랍 §17 · 「+ 구성원」 시간대 칸) 행 하나만 고치면 된다.
 *
 * **키로 찾고, 옛 이름일 때만 고친다** (C54 의 KIND·SUB 이름 되돌림과 같은 방식).
 * `tz` 는 IANA 식별자라 어느 행인지 정확히 가리키고, 이름을 누가 따로 바꿔 두었다면(`name` 이 옛 값이 아니면)
 * 그 글을 덮지 않는다. 표의 모양(컬럼·제약)은 그대로다 — ERD 변경 0.
 *
 * `down` 도 같은 조건으로 되돌린다 — 지금 이름이 「서울」인 `Asia/Seoul` 행만 옛 이름으로.
 */
export class TzgSeoulName1763200000000 implements MigrationInterface {
  name = 'TzgSeoulName1763200000000';

  private static readonly TZ = 'Asia/Seoul';
  private static readonly OLD = '한국 (KST)';
  private static readonly NEW = '서울';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE tzg SET name = $1 WHERE tz = $2 AND name = $3`,
      [TzgSeoulName1763200000000.NEW, TzgSeoulName1763200000000.TZ, TzgSeoulName1763200000000.OLD],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE tzg SET name = $1 WHERE tz = $2 AND name = $3`,
      [TzgSeoulName1763200000000.OLD, TzgSeoulName1763200000000.TZ, TzgSeoulName1763200000000.NEW],
    );
  }
}
