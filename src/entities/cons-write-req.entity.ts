/** @file-guide
 * 목적: 컨설팅 생성·핵심정보·공개범위 요청의 멱등 결과를 매핑한다. (entity)
 * 책임/재사용: 같은 actor·payload 재시도만 같은 결과로 수렴시킨다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · migration 1766700000000
 */
import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
@Entity({ name: 'cons_write_req' })
@Index('cons_write_req_cons_idx', ['consId', 'createdAt'])
@Check('cons_write_req_action_check', "action IN ('create','core','share','invoice')")
@Check('cons_write_req_fingerprint_hex', "fingerprint ~ '^[0-9a-f]{64}$'")
@Check('cons_write_req_version_positive', 'result_version >= 1')
export class ConsWriteReq {
  @PrimaryColumn({ type: 'uuid' }) requestKey: string;
  @Column({ type: 'varchar', length: 16 }) action: string;
  @Column({ type: 'bigint' }) consId: number;
  @Column({ type: 'char', length: 64 }) fingerprint: string;
  @Column({ type: 'int' }) resultVersion: number;
  @Column({ type: 'bigint', nullable: true }) resultRefId: number | null;
  @Column({ type: 'bigint' }) actorId: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
