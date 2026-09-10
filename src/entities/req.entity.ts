/** @file-guide
 * 목적: req 테이블 ORM 매핑 — Req (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * REQ — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'req' })
export class Req {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 강사가 올린다 */
  @Column({ type: 'bigint' })
  staffId: number;

  @Column({ type: 'varchar', length: 16 })
  reqType: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  state: string;

  @Column({ type: 'bigint', nullable: true })
  resolvedBy: number | null;

  /** 반려 시 필수 (D-R13) */
  @Column({ type: 'text', nullable: true })
  rejectReason: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
