/** @file-guide
 * 목적: cons_item 테이블 ORM 매핑 — ConsItem (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * CONS_ITEM — docs/contracts/db/erd.dbml v4.13 (N-18 채택 · 47D-B 항목 원장).
 * 진행률은 이 원장의 projection 이며 별도 숫자로 저장하지 않는다 (47D-A).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['consId', 'seq'], { unique: true })
@Entity({ name: 'cons_item' })
@Check('cons_item_source_check', "source IN ('template','manual')")
export class ConsItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  consId: number;

  @Column({ type: 'smallint' })
  seq: number;

  @Column({ type: 'varchar', length: 80 })
  label: string;

  /** 필수 지정은 종료 전이 게이트(47D-C)와 함께 확정 — 지금은 표기만 */
  @Column({ type: 'boolean', default: false })
  required: boolean;

  @Column({ type: 'boolean', default: false })
  done: boolean;

  @Column({ type: 'bigint', nullable: true })
  doneBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  doneAt: Date | null;

  /** template = §29 자동 생성분 · manual = 학생별 추가 (N-18-a 확정 전 쓰기 없음) */
  @Column({ type: 'varchar', length: 10, default: 'template' })
  source: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
