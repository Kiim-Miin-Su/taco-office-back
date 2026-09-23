/** @file-guide
 * 목적: gpapack 테이블 ORM 매핑 — Gpapack (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GPAPACK — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'gpapack' })
export class Gpapack {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** exam(시험 대비) | self(자습) — 두 가지만 받는다 */
  @Column({ type: 'varchar', length: 12 })
  packType: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'text', nullable: true })
  memo: string | null;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  state: string;

  /** 33 적용 전 원문 상태. 승인으로부터 전달 완료를 추정하지 않기 위한 이관 증거. */
  @Column({ type: 'varchar', length: 12, nullable: true })
  legacyState: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;

  @Column({ type: 'date', nullable: true })
  effectiveOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  coordinatorId: number | null;

  @Column({ type: 'bigint', nullable: true })
  createdBy: number | null;

  @Column({ type: 'bigint', nullable: true })
  deliveredBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  receivedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
