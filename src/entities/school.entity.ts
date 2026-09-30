/** @file-guide
 * 목적: school.entity.ts — SCHOOL 테이블 ORM 매핑 (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기 metadata를 함께 대조한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SCHOOL — docs/contracts/db/erd.dbml v4.59 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['nameKey'])
@Index(['countryCode'])
@Entity({ name: 'school' })
export class School {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  region: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  campus: string | null;

  /** GENERATED ALWAYS AS normalize_school_identity(name) STORED · client 입력 금지 */
  @Column({ type: 'text', insert: false, update: false })
  nameKey: string;

  /** GENERATED ALWAYS AS normalize_school_identity(coalesce(region, 빈 문자열)) STORED */
  @Column({ type: 'text', insert: false, update: false })
  regionKey: string;

  /** GENERATED ALWAYS AS normalize_school_identity(coalesce(campus, 빈 문자열)) STORED */
  @Column({ type: 'text', insert: false, update: false })
  campusKey: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** 신규 사용자 추가는 실제 actor; legacy/import NULL은 미상 */
  @Column({ type: 'bigint', nullable: true })
  createdBy: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
