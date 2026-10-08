/** @file-guide
 * 목적: 일반 자료요청의 요청 첨부와 전달 파일을 해당 전이 event에 연결한다.
 * 책임/재사용: FILE 본문·MIME은 공용 file 표를 재사용하고 링크 목적과 추가 actor만 보존한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'material_request_file' })
@Unique('material_request_file_once', ['fileId'])
@Index('material_request_file_request_idx', ['materialRequestId', 'purpose', 'id'])
@ForeignKey('material_request', ['materialRequestId'], ['id'], { name: 'material_request_file_request_fk', onDelete: 'CASCADE' })
@ForeignKey('material_request_event', ['eventId'], ['id'], { name: 'material_request_file_event_fk', onDelete: 'CASCADE' })
@ForeignKey('file', ['fileId'], ['id'], { name: 'material_request_file_file_fk', onDelete: 'RESTRICT' })
@ForeignKey('staff', ['addedBy'], ['id'], { name: 'material_request_file_actor_fk', onDelete: 'RESTRICT' })
@Check('material_request_file_purpose_words', "\"purpose\" IN ('request','delivery')")
export class MaterialRequestFile {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) materialRequestId: number;
  @Column({ type: 'bigint' }) eventId: number;
  @Column({ type: 'bigint' }) fileId: number;
  @Column({ type: 'varchar', length: 12 }) purpose: string;
  @Column({ type: 'bigint' }) addedBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
