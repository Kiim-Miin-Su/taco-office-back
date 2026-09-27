/** @file-guide
 * 목적: 1764320000000-kind-cap-source.ts — KindCapSource1764320000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 모의수업 · GPA 의 정원을 원문 표의 **1** 로 (N-30 ① 채택 · W11 · 원문 슬라이드 88 「mock 모의수업 1 · gpa GPA 1」).
 *
 * 데이터만 바꾼다 — 표의 모양(컬럼·제약)은 그대로다(ERD 변경 0).
 * **옛 기본값일 때만** 고친다(mock 20 · gpa 4 — 시드와 C54 이전 값). 관리자가 §18 「프로그램 · 과목 관리」에서
 * 따로 정해 둔 정원이면(값이 옛 기본값이 아니면) 그 결정을 덮지 않는다 — `1763200000000-tzg-seoul-name` 과 같은 모양이다.
 *
 * 정원은 **막는 값이 아니라 알리는 값**이다 — 명단 쓰기는 정원을 세어 「정원 1명 · 자리가 없습니다」라고 알릴 뿐
 * 넣기를 막지 않는다(S5-a 「초과 표시」). 그래서 이미 있는 명단 행(시드의 4인 모의수업 · 2인 GPA)은 한 줄도 안 바뀌고
 * 초과로 보일 뿐이다 — 쪼개지도 지우지도 않는다(돈 · 정산 원장을 건드리지 않는다).
 *
 * SUB 키 구분자(원문 밑줄 map_read · 우리는 붙임표 map-read)는 **그대로다**(N-30 ②) — 발행된 청구서 줄
 * (`inv_line.sub_key`)까지 고치는 이관이 되기 때문이다.
 *
 * `down` 도 같은 조건으로 되돌린다 — 지금 정원이 1 인 mock · gpa 만 옛 값으로.
 */
export class KindCapSource1764320000000 implements MigrationInterface {
  name = 'KindCapSource1764320000000';

  /** [키, 옛 기본 정원, 원문 정원] */
  private static readonly CAPS: ReadonlyArray<readonly [string, number, number]> = [
    ['mock', 20, 1],
    ['gpa', 4, 1],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [key, legacy, source] of KindCapSource1764320000000.CAPS) {
      await q.query(`UPDATE kind SET cap = $1 WHERE key = $2 AND cap = $3`, [source, key, legacy]);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [key, legacy, source] of KindCapSource1764320000000.CAPS) {
      await q.query(`UPDATE kind SET cap = $1 WHERE key = $2 AND cap = $3`, [legacy, key, source]);
    }
  }
}
