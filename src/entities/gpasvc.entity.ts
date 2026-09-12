/** @file-guide
 * 목적: gpasvc 테이블 ORM 매핑 — Gpasvc (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** GPASVC — docs/contracts/db/erd.dbml v4.15 (N-13 채택 · v2 §4.5 서비스 5종). */
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'gpasvc' })
export class Gpasvc {
  @PrimaryColumn({ type: 'varchar', length: 8 })
  key: string;

  @Column({ type: 'varchar', length: 30 })
  name: string;

  /** 회차마다 배정량에서 깎이는 포인트 (D-R29) — 원문: 1·2·2·4·6 */
  @Column({ type: 'smallint' })
  point: number;

  @Column({ type: 'char', length: 7, nullable: true })
  color: string | null;

  @Column({ type: 'smallint', nullable: true })
  sort: number | null;
}
