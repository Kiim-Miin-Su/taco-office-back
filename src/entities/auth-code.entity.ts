/** @file-guide
 * 목적: auth_code 테이블 ORM 매핑 — AuthCode (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * AUTH_CODE — 첫 설정의 이메일 · 휴대폰 인증 코드 한 줄 (erd.dbml v4.50 · W8).
 *
 * **코드와 받는 곳의 원문을 저장하지 않는다** — `code_hash` · `target_hash` 는 서버 비밀로 만든 HMAC 이고,
 * 사람이 읽는 것은 가린 받는 곳(`target_masked`)뿐이다. 원장이 새어도 코드를 되살리거나 연락처를 읽을 수 없다.
 * 시도 수 · 만료 · 쓴 시각을 한 줄이 갖는다 — 다섯 번 틀리면 그 코드는 끝난다(판정은 서비스 한 곳).
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index('auth_code_staff_channel_idx', ['staffId', 'channel', 'createdAt'])
@Entity({ name: 'auth_code' })
export class AuthCode {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  /** email | sms (auth_code_channel_words CHECK) */
  @Column({ type: 'varchar', length: 8 })
  channel: string;

  @Column({ type: 'varchar', length: 64 })
  targetHash: string;

  @Column({ type: 'varchar', length: 160 })
  targetMasked: string;

  @Column({ type: 'varchar', length: 64 })
  codeHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
