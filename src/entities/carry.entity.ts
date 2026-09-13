/** @file-guide
 * 목적: carry 테이블 ORM 매핑 — Carry (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * CARRY — §54 「이월 처리」가 남기는 줄 (대표 결정 2026-09-13 · N-39).
 *
 * 「이월 처리는 **수업이 결제 됐으나 정해진 시수가 채워지지 않은 경우**」 — 받아 놓고 못 해 준 수업이다.
 * 넘긴 사실은 돈이 걸린 일이라 화면에만 두지 않는다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['studentId', 'fromMonth'], { unique: true })
@Index(['toMonth'])
@Entity({ name: 'carry' })
export class Carry {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** 못 해 준 수업이 있던 달 — `YYYY-MM` */
  @Column({ type: 'text' })
  fromMonth: string;

  /** 넘겨 받는 달 — `YYYY-MM` */
  @Column({ type: 'text' })
  toMonth: string;

  @Column({ type: 'int' })
  amount: number;

  /** 못 해 준 회차 수 — 금액만 남기면 나중에 무엇을 몇 번 못 했는지 못 되짚는다 */
  @Column({ type: 'int' })
  sessions: number;

  /** 근거가 된 완납 청구서 */
  @Column({ type: 'bigint', nullable: true })
  invId: number | null;

  @Column({ type: 'bigint' })
  byId: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
