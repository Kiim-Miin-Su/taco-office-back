/** @file-guide
 * 목적: mtagenda 테이블 ORM 매핑 — Mtagenda (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. 업무 잠금·version 충돌은 OpsService와 migration trigger가 검증한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/decisions/PLANNING-REQUIRED.md BO-Q13
 */

import { Check, Column, Entity, ForeignKey, PrimaryColumn } from 'typeorm';

@ForeignKey('mtrec', ['mtId'], ['id'], { name: 'mtagenda_meeting_fk', onDelete: 'CASCADE' })
@ForeignKey('staff', ['createdBy'], ['id'], { name: 'mtagenda_created_by_fk', onDelete: 'RESTRICT' })
@ForeignKey('staff', ['updatedBy'], ['id'], { name: 'mtagenda_updated_by_fk', onDelete: 'RESTRICT' })
@Check('mtagenda_content_present', 'char_length(btrim("content")) BETWEEN 1 AND 8000')
@Check('mtagenda_version_positive', '"version" >= 1')
@Check('mtagenda_time_order', '"updated_at" >= "created_at"')
@Entity({ name: 'mtagenda' })
export class Mtagenda {
  @PrimaryColumn({ type: 'bigint' })
  mtId: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'integer', default: 1 })
  version: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'bigint' })
  createdBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @Column({ type: 'bigint' })
  updatedBy: number;
}
