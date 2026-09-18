/** @file-guide
 * 목적: stu_pause 테이블 ORM 매핑 — StuPause (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * STU_PAUSE — 학생의 **휴원 기간** (C92-c · 테스트 시나리오 C-36 「장기 휴원」 · C-37 「복귀」).
 *
 * 기간 안의 회차는 그 학생에게 「그날만 빠짐」과 같은 것이다 — 시간표에서 빠지고 청구되지 않는다
 * (`lib/sql.STU_PAUSED_ON`). 회차를 지우거나 규칙을 끊지 않는다: 복귀하면 그대로 돌아온다.
 * 복귀 처리는 `to_date` 를 복귀 전날로 당기고 `resumed_*` 에 누가·언제를 남긴다 — **기간은 이력으로 남는다**.
 * 같은 학생의 기간은 겹치지 않는다 (`stu_pause_no_overlap` EXCLUDE).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('stu_pause_range', 'to_date IS NULL OR to_date >= from_date')
@Index(['studentId', 'fromDate'])
@Entity({ name: 'stu_pause' })
export class StuPause {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** 휴원 시작일 — 이 날부터 회차에서 빠진다 */
  @Column({ type: 'date' })
  fromDate: string;

  /** 휴원 종료일(포함) — null 이면 복귀 전까지 무기한 */
  @Column({ type: 'date', nullable: true })
  toDate: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint' })
  byId: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;

  /** 복귀 처리 — 누가·언제. to_date 는 복귀 전날로 당겨진다 */
  @Column({ type: 'bigint', nullable: true })
  resumedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  resumedAt: Date | null;
}
