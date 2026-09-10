/** @file-guide
 * 목적: staff 테이블 ORM 매핑 — Staff (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * STAFF — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ROLE_T_VALUES } from './enums';

@Entity({ name: 'staff' })
export class Staff {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /** D-R39 — 권한의 유일한 출처 */
  @Column({ type: 'enum', enum: ROLE_T_VALUES, enumName: 'role_t' })
  role: 'teacher'|'manager'|'admin'|'ceo';

  /** 직함 표시용 — 교수실장 · 상담실장 · 코디네이터. 권한과 무관 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  title: string | null;

  /** 관리자 화면은 KST 고정 · 개인 화면에만 적용 (§17) */
  @Column({ type: 'varchar', length: 40, default: 'Asia/Seoul' })
  tz: string;

  /** bcrypt. 길이 60 이지만 알고리즘이 바뀔 자리를 둔다 */
  @Column({ type: 'varchar', length: 72, nullable: true })
  passwordHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  /** SENS 인증 완료 여부 (TBO-15) */
  @Column({ type: 'boolean', default: false })
  phoneVerified: boolean;

  /** 지출 · 총수입 — NULL 이면 role==ceo */
  @Column({ type: 'boolean', nullable: true })
  canMoney: boolean | null;

  /** 강사 시급 · 시수 기준 — NULL 이면 role!=teacher */
  @Column({ type: 'boolean', nullable: true })
  canWage: boolean | null;

  /** 보고 · 기획 · 지출 결재 — NULL 이면 role!=teacher */
  @Column({ type: 'boolean', nullable: true })
  canApprove: boolean | null;

  /** 내역 비공개 · 비공개 컨설팅 열람 — NULL 이면 role!=teacher */
  @Column({ type: 'boolean', nullable: true })
  canHide: boolean | null;

  /** 자료 요청 접수 — NULL 이면 role!=teacher */
  @Column({ type: 'boolean', nullable: true })
  canGpaPack: boolean | null;

  /** 불가 시간 2주 회차의 기산점 */
  @Column({ type: 'date', nullable: true })
  hiredOn: string | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
