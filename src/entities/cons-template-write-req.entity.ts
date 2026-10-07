/** @file-guide
 * 목적: 컨설팅 기본 항목 version 생성 요청의 멱등 결과를 매핑한다. (entity)
 * 책임/재사용: 설정 저장 재시도가 새 version을 중복 생성하지 않게 한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · migration 1766700000000
 */
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
@Entity({ name: 'cons_template_write_req' })
@Check('cons_template_write_req_fingerprint_hex', "fingerprint ~ '^[0-9a-f]{64}$'")
@Check('cons_template_write_req_version_positive', 'result_version >= 1')
export class ConsTemplateWriteReq {
  @PrimaryColumn({ type: 'uuid' }) requestKey: string;
  @Column({ type: 'varchar', length: 20 }) consType: string;
  @Column({ type: 'bigint' }) templateId: number;
  @Column({ type: 'char', length: 64 }) fingerprint: string;
  @Column({ type: 'int' }) resultVersion: number;
  @Column({ type: 'bigint' }) actorId: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
