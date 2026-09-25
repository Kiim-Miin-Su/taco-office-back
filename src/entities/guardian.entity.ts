/** @file-guide
 * 목적: guardian 테이블 ORM 매핑 — Guardian (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GUARDIAN — 학생의 보호자 (DQ3 대표 답변 2026-09-25 · N-42 · v4.42).
 *
 * 학생 한 명에 여러 명이고, 발송 때 사람이 고른다. **지우지 않는다** — `guardian_send` 원장이 가리키므로
 * 「삭제」는 `active=false` 다. 연락처는 강사 응답 어디에도 싣지 않는다(관리 화면 전용 · @Perm canAdminPage+canCrudAll).
 * 휴대폰은 숫자만 저장한다(`notify/sender.phoneDigits`).
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['studentId'])
@Index('guardian_one_primary', ['studentId'], { unique: true, where: '"is_primary"' })
@ForeignKey('stu', ['studentId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['createdBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('guardian_name_present', 'length(btrim(name)) > 0')
@Check('guardian_contact_present', 'email IS NOT NULL OR phone IS NOT NULL')
@Check('guardian_email_shape', "email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'")
@Check('guardian_phone_digits', "phone IS NULL OR phone ~ '^0[0-9]{9,10}$'")
@Check('guardian_email_channel', 'NOT receive_email OR email IS NOT NULL')
@Check('guardian_sms_channel', 'NOT receive_sms OR phone IS NOT NULL')
@Check('guardian_primary_active', 'active OR NOT is_primary')
@Entity({ name: 'guardian' })
export class Guardian {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** 어머니 · 아버지 · 보호자 … 사람이 적는 짧은 말 (코드가 아니다) */
  @Column({ type: 'varchar', length: 20, nullable: true })
  relation: string | null;

  @Column({ type: 'varchar', length: 254, nullable: true })
  email: string | null;

  /** 숫자만 — 010xxxxxxxx */
  @Column({ type: 'varchar', length: 11, nullable: true })
  phone: string | null;

  @Column({ type: 'boolean', default: true })
  receiveEmail: boolean;

  @Column({ type: 'boolean', default: false })
  receiveSms: boolean;

  /** 대표 보호자 — 학생당 하나(부분 유니크 guardian_one_primary). 발송 창에서 미리 체크된다 */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'bigint' })
  createdBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
