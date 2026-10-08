/** @file-guide
 * 목적: 일반 자료요청 생성·준비·전달·반려·수신확인의 실제 actor와 멱등 결과 version을 보존한다.
 * 책임/재사용: 본문을 복제하지 않고 payload SHA-256과 전이 결과만 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-08D2-MATERIAL-REQUEST-PERSISTENCE-2026-10-09.md · docs/contracts/db/erd.dbml
 */

import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'material_request_event' })
@Unique('material_request_event_request_key_unique', ['requestKey'])
@Unique('material_request_event_version_unique', ['materialRequestId', 'resultVersion'])
@Index('material_request_event_request_idx', ['materialRequestId', 'createdAt', 'id'])
@ForeignKey('material_request', ['materialRequestId'], ['id'], { name: 'material_request_event_request_fk', onDelete: 'CASCADE' })
@ForeignKey('staff', ['actorId'], ['id'], { name: 'material_request_event_actor_fk', onDelete: 'RESTRICT' })
@Check('material_request_event_action_words', "\"action\" IN ('created','preparing','delivered','rejected','acknowledged')")
@Check('material_request_event_state_words', "\"to_state\" IN ('received','preparing','delivered','rejected') AND (\"from_state\" IS NULL OR \"from_state\" IN ('received','preparing','delivered','rejected'))")
@Check('material_request_event_payload_sha', "\"payload_sha256\" ~ '^[0-9a-f]{64}$'")
@Check('material_request_event_result_version_positive', '"result_version" >= 1')
@Check('material_request_event_shape', `
  ("action"='created' AND "from_state" IS NULL AND "to_state"='received' AND "result_version"=1 AND "reason" IS NULL)
  OR ("action"='preparing' AND "from_state"='received' AND "to_state"='preparing' AND "reason" IS NULL)
  OR ("action"='delivered' AND "from_state"='preparing' AND "to_state"='delivered' AND "reason" IS NULL)
  OR ("action"='rejected' AND "from_state" IN ('received','preparing') AND "to_state"='rejected' AND length(btrim("reason")) >= 2)
  OR ("action"='acknowledged' AND "from_state"='delivered' AND "to_state"='delivered' AND "reason" IS NULL)
`)
export class MaterialRequestEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) materialRequestId: number;
  @Column({ type: 'varchar', length: 20 }) action: string;
  @Column({ type: 'varchar', length: 16, nullable: true }) fromState: string | null;
  @Column({ type: 'varchar', length: 16 }) toState: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) reason: string | null;
  @Column({ type: 'bigint' }) actorId: number;
  @Column({ type: 'uuid' }) requestKey: string;
  @Column({ type: 'char', length: 64 }) payloadSha256: string;
  @Column({ type: 'int' }) resultVersion: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
