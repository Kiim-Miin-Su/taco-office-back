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
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ROLE_T_VALUES } from './enums';

/**
 * 로그인 아이디(이메일)는 대소문자를 가리지 않고 유일하다 — `lower(email)` 식 색인(v4.51 · 1763700000000).
 * 식 색인은 데코레이터로 적을 수 없어 이름만 알리고 동기화에서 뺀다(마이그레이션이 주인이다).
 */
@Index('staff_email_lower_key', { synchronize: false })
@Entity({ name: 'staff' })
export class Staff {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** 로그인 아이디 (W8 · 2026-09-26). 저장 · 비교는 소문자 정규화(lib/account-policy) · `lower(email)` 유일(v4.51) */
  @Column({ type: 'varchar', length: 120, unique: true })
  email: string;

  /** 휴대폰 — 한국 번호는 숫자만(`01012345678`), 해외 번호는 `+국가번호…`(E.164 · N-103 · 2026-09-26). 모양 판정은 lib/phone 한 곳 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /** D-R39 — 권한의 유일한 출처 */
  @Column({ type: 'enum', enum: ROLE_T_VALUES, enumName: 'role_t' })
  role: 'teacher'|'manager'|'admin'|'ceo';

  /** 직함 표시용 — 매니저 · 상담실장 · 코디네이터. 권한과 무관 (교수실장 직함은 없음, 2026-09-12) */
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

  /**
   * 첫 설정(아이디=이메일 · 비밀번호 · 휴대폰 · 이메일 인증)을 끝내야 하는 계정 (W8 · 2026-09-26 · v4.50).
   * 켜는 곳은 넷뿐 — 관리자의 계정 만들기 · 비밀번호 초기화 · 이메일/휴대폰 수정(N-104 · 2026-09-26) · 운영 전환 스크립트.
   * 켜져 있으면 첫 설정 경로 밖의 API 는 403.
   */
  @Column({ type: 'boolean', default: false })
  mustChangeCredentials: boolean;

  /** 이메일 인증 완료 여부 (W8 · v4.50) — 휴대폰의 `phoneVerified` 와 짝 */
  @Column({ type: 'boolean', default: false })
  emailVerified: boolean;

  /**
   * 마지막으로 이 계정의 아이디·비밀번호가 (다시) 정해진 시각 (W8 · v4.50 · v4.51 뜻 넓힘) — 누가 했든 찍는다:
   * 본인 첫 설정 완료 · 본인 비밀번호 찾기(N-101) · 관리자 비밀번호 초기화 · 운영 전환 스크립트. 이보다 먼저 발급된 Access · Refresh 토큰은
   * 401 「다시 로그인해 주세요」다(AuthService) — 초기 비밀번호를 아는 만든 사람의 세션도 여기서 끊긴다. 옛 행 NULL = 끊지 않는다.
   */
  @Column({ type: 'timestamptz', nullable: true })
  credentialsChangedAt: Date | null;

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
