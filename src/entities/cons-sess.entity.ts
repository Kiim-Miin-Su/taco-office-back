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

  /** 회차 기록 시 스케줄이 생긴다 */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;
}
