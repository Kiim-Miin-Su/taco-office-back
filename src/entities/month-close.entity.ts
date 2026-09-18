/** @file-guide
 * 목적: month_close 테이블 ORM 매핑 — MonthClose (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * MONTH_CLOSE — §54 「N월 마감」 (C92-d · 테스트 시나리오 C-39 · L-123 · N-140).
 *
 * 마감된 달은 **그 달의 회차·휴강·출결·청구·이월·휴원 쓰기가 409 `MONTH_CLOSED` 로 막힌다** —
 * 판정은 `lib/month-close` 한 곳이고, 스케줄 쓰기는 「마감 달의 회차·예외가 실제로 달라졌는가」를
 * 트랜잭션 안에서 견줘 막는다. 해제는 대표 전용이고 사유가 필수이며 **행을 지우지 않고** `reopened_*` 를
 * 채운다(N-140 「흔적 없이 고쳐지면 실패」). 다시 마감하면 새 행이 선다 — 한 달의 마감·해제가 전부 이력이다.
 * 열려 있는 마감은 달마다 하나(`month_close_open_once` 부분 유니크).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('month_close_shape', "year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'")
@Check('month_close_reopen_pair', '(reopened_at IS NULL) = (reopened_by IS NULL) AND (reopened_at IS NULL OR reopen_reason IS NOT NULL)')
@Index(['yearMonth'])
@Entity({ name: 'month_close' })
export class MonthClose {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** `YYYY-MM` */
  @Column({ type: 'text' })
  yearMonth: string;

  @Column({ type: 'bigint' })
  closedBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  closedAt: Date;

  /** 해제 — 누가·언제·왜. 셋이 짝이다 */
  @Column({ type: 'bigint', nullable: true })
  reopenedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  reopenedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reopenReason: string | null;
}
