/** @file-guide
 * 목적: STU_PROFILE_AUDIT 불변 감사 원장 ORM 매핑.
 * 책임/재사용: 학생 기록시점·actor·version의 DB 컬럼만 매핑한다. 허가·PII mask·writer 정책은 서비스 책임이다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/db/student-registration-target.dbml
 */

import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index('stu_profile_audit_student_identity', ['id', 'studentId'], { unique: true })
@Index('stu_profile_audit_version_unique', ['studentId', 'versionAfter'], { unique: true })
@Index('stu_profile_audit_request_unique', ['studentId', 'requestKey'], { unique: true })
@Entity({ name: 'stu_profile_audit' })
export class StuProfileAudit {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 32 })
  action: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  field: string | null;

  @Column({ type: 'uuid' })
  requestKey: string;

  @Column({ type: 'bytea' })
  requestFingerprint: Buffer;

  @Column({ type: 'bigint' })
  versionBefore: string;

  @Column({ type: 'bigint' })
  versionAfter: string;

  @Column({ type: 'jsonb', nullable: true })
  beforeData: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  afterData: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint' })
  recordedBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  recordedAt: Date;

  /** DB trigger가 현재 transaction id로 덮어쓴다. 외부 DTO에 노출하지 않는다. */
  @Column({ type: 'bigint', default: () => 'txid_current()' })
  writeTxid: string;
}
