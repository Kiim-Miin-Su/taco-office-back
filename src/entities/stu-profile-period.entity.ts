/** @file-guide
 * 목적: STU_PROFILE_PERIOD 학생 유효기간·typed payload·정정 원본 ORM 매핑.
 * 책임/재사용: DB 컬럼만 매핑한다. 정밀도 정규화는 student-profile-period.ts, 기록은 audit writer가 소유한다.
 * 검증/작업 지침: docs/contracts/db/erd.dbml · docs/contracts/db/student-registration-target.dbml
 */

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'stu_profile_period' })
export class StuProfilePeriod {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 16 })
  field: string;

  @Column({ type: 'date' })
  validFrom: string;

  @Column({ type: 'date', nullable: true })
  validTo: string | null;

  @Column({ type: 'varchar', length: 5, default: 'day' })
  fromPrecision: string;

  @Column({ type: 'varchar', length: 5, nullable: true })
  toPrecision: string | null;

  @Column({ type: 'boolean', default: false })
  fromDerived: boolean;

  @Column({ type: 'boolean', default: false })
  toDerived: boolean;

  @Column({ type: 'varchar', length: 5, nullable: true })
  educationSystem: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  gradeCode: string | null;

  @Column({ type: 'bigint', nullable: true })
  schoolId: number | null;

  @Column({ type: 'char', length: 2, nullable: true })
  residenceCountryCode: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  residenceTimezone: string | null;

  @Column({ type: 'text', nullable: true })
  textValue: string | null;

  @Column({ type: 'text', nullable: true })
  memo: string | null;

  @Column({ type: 'bigint' })
  createdAuditId: number;

  @Column({ type: 'bigint' })
  recordedBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  recordedAt: Date;

  @Column({ type: 'bigint', nullable: true })
  supersededByAuditId: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  supersededAt: Date | null;
}
