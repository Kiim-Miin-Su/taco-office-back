/** @file-guide
 * 목적: zassign 테이블 ORM 매핑 — Zassign (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * ZASSIGN — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'zassign' })
export class Zassign {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'bigint', nullable: true })
  excId: number | null;

  @Column({ type: 'bigint' })
  zaccId: number;

  /** 고정 배정 vs 변동 */
  @Column({ type: 'boolean', default: true })
  fixed: boolean;
}
