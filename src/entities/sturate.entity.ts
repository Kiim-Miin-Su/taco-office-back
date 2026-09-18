/** @file-guide
 * 목적: sturate 테이블 ORM 매핑 — Sturate (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * STURATE — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, PrimaryGeneratedColumn } from 'typeorm';

// C94-d (v4.31 · migration 1761000000000): 예외에는 사유·누가·언제 — 새 행은 사유 필수 (NOT VALID · 옛 시드 2행 보정 0)
@Check('sturate_reason_present', '"reason" IS NOT NULL AND btrim("reason") <> \'\'')
@ForeignKey('staff', ['byId'], ['id'], { name: 'sturate_by_id_fkey', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'sturate' })
export class Sturate {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 16, nullable: true })
  kindKey: string | null;

  @Column({ type: 'int' })
  unitPrice: number;

  @Column({ type: 'date' })
  fromDate: string;

  /** 예외 사유 — 「형제 할인」 · 「장학」 … (H-81 「사유가 없으면 실패」) */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
