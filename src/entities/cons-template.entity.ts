/** @file-guide
 * 목적: 유형별 컨설팅 기본 항목의 immutable version 머리를 매핑한다. (entity)
 * 책임/재사용: DB 매핑만 소유하고 UI 기본값을 중복 보유하지 않는다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · migration 1766700000000
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
@Entity({ name: 'cons_template' })
@Unique('cons_template_type_version_uniq', ['consType', 'version'])
@Index('cons_template_active_type_once', ['consType'], { unique: true, where: 'active' })
@Check('cons_template_version_positive', 'version >= 1')
export class ConsTemplate {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'varchar', length: 20 }) consType: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'bigint', nullable: true }) createdBy: number | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
