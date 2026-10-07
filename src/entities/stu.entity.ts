/** @file-guide
 * 목적: stu 테이블 ORM 매핑 — Stu (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * STU — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

// W11 수동 CHECK metadata: migration 1764110000000 과 함께 보존/검증한다 (N-83).
@Check('stu_gender_words', "\"gender\" IS NULL OR \"gender\" IN ('female','male')")
@Check('stu_english_name_present', 'english_name IS NULL OR (english_name = btrim(english_name) AND length(english_name) > 0)')
@Check('stu_source_words', "source IS NULL OR source IN ('kakao','phone','blog','instagram','referral','walkin')")
@Check('stu_cash_receipt_pair', '(cash_receipt_encrypted IS NULL AND cash_receipt_key_version IS NULL) OR (cash_receipt_encrypted IS NOT NULL AND cash_receipt_key_version IS NOT NULL AND length(btrim(cash_receipt_key_version)) BETWEEN 1 AND 40)')
@Check('stu_registration_contract', "registration_contract_version IN (0,1) AND (registration_contract_version = 0 OR (gender IS NOT NULL AND created_by IS NOT NULL AND registration_request_key IS NOT NULL))")
@Index('stu_registration_request_once', ['registrationRequestKey'], { unique: true, where: 'registration_request_key IS NOT NULL' })
@ForeignKey('staff', ['createdBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'stu' })
export class Stu {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  grade: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  school: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  targetExam: string | null;

  @Column({ type: 'date', nullable: true })
  startedOn: string | null;

  /** 지도 강도 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  guidance: string | null;

  /** 수업 언어 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  lang: string | null;

  /**
   * 성별 — 선택 칸(female · male · NULL) (N-83 · W11). 옛 학생은 NULL 이고 추정해 채우지 않는다.
   * **관리자 §10 아바타에만** 쓴다 — 학부모·외부 출력(리포트 · 안내 · 보호자 발송 · PNG)에는 싣지 않는다.
   */
  @Column({ type: 'varchar', length: 6, nullable: true })
  gender: string | null;

  /** BOC-03D-04a 권고안 채택: 옛 학생과 기존 등록 writer의 선택 정적 칸은 NULL 그대로다. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  englishName: string | null;

  @Column({ type: 'date', nullable: true })
  birthDate: string | null;

  @Column({ type: 'boolean', nullable: true })
  hasCitizenship: boolean | null;

  /** LEAD.source의 기존 여섯 코드만 받으며 옛 LEAD에서 추정해 채우지 않는다. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  source: string | null;

  /** BOC-03D-04b 권고안: 현금영수증 원문은 독립 PII key의 AES-GCM envelope로만 저장한다. */
  @Column({ type: 'bytea', nullable: true })
  cashReceiptEncrypted: Buffer | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  cashReceiptKeyVersion: string | null;

  /** legacy/기존 최소 writer는 NULL, 15절 신규 writer는 인증 actor를 기록한다. */
  @Column({ type: 'bigint', nullable: true })
  createdBy: number | null;

  @Column({ type: 'smallint', default: 0 })
  registrationContractVersion: number;

  @Column({ type: 'uuid', nullable: true })
  registrationRequestKey: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;

  /** ST1-b2 감사가 학생 row lock 아래 전진시킨다. 기존 scalar는 기간값으로 이관하지 않는다. */
  @Column({ type: 'bigint', default: 0 })
  profileVersion: string;
}
