/** @file-guide
 * 목적: 컨설팅 기본 항목 version의 순서·필수 여부를 매핑한다. (entity)
 * 책임/재사용: 실제 계약 CONS_ITEM은 이 값을 snapshot으로 복사하며 이 행을 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · migration 1766700000000
 */
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
@Entity({ name: 'cons_template_item' })
@Check('cons_template_item_seq_positive', 'seq >= 1')
@Check('cons_template_item_label_nonempty', 'length(btrim(label)) > 0')
export class ConsTemplateItem {
  @PrimaryColumn({ type: 'bigint' }) templateId: number;
  @PrimaryColumn({ type: 'smallint' }) seq: number;
  @Column({ type: 'varchar', length: 80 }) label: string;
  @Column({ type: 'boolean', default: true }) required: boolean;
}
