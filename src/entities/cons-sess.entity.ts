/** @file-guide
 * 목적: cons_sess 테이블 ORM 매핑 — ConsSess (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * CONS_SESS — docs/contracts/db/erd.dbml v4.11 대조. TBO-47C CHECK/UNIQUE 보강.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'cons_sess' })
@Check('cons_sess_seq_check', 'seq > 0')
@Unique('cons_sess_cons_seq_uniq', ['consId', 'seq'])
export class ConsSess {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  consId: number;

  @Column({ type: 'smallint' })
  seq: number;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'text', nullable: true })
  who: string | null;

  @Column({ type: 'text', nullable: true })
  what: string | null;

  @Column({ type: 'text', nullable: true })
  why: string | null;

  @Column({ type: 'text', nullable: true })
  how: string | null;

  /** v4.44 · 「결과」 — 원본 §31 회차 본문의 인용 상자 (31-08) */
  @Column({ type: 'text', nullable: true })
  result: string | null;

  /** v4.44 · 「다음까지」 — 적으면 담당의 할 일(TODO)과 알림이 같은 트랜잭션에서 선다 (슬라이드 31 연동 · 31-08) */
  @Column({ type: 'text', nullable: true })
  nextUntil: string | null;

  /** 회차 기록 시 스케줄이 생긴다 */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;
}
