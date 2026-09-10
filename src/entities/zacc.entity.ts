/** @file-guide
 * 목적: zacc 테이블 ORM 매핑 — Zacc (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * ZACC — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'zacc' })
export class Zacc {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 20, unique: true })
  label: string;

  @Column({ type: 'varchar', length: 120 })
  loginEmail: string;

  /** AES-256 · 평문 금지 · 키는 별도 저장소 */
  @Column({ type: 'bytea' })
  loginSecret: Buffer;

  /** 학생용 참가 링크 — 로그인 정보와 절대 같은 자리에 두지 않는다 */
  @Column({ type: 'text' })
  joinUrl: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  meetingId: string | null;

  @Column({ type: 'bytea', nullable: true })
  meetingPwEnc: Buffer | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
