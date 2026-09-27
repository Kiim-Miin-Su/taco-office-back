/** @file-guide
 * 목적: inv_installment 테이블 ORM 매핑 — InvInstallment (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * INV_INSTALLMENT — 청구서의 **분납 일정** (N-79 채택 · W11 · migration 1764200000000).
 *
 * 선택 입력이다 — 일정이 없는 청구서는 `inv.due_on` 하나로 기한을 본다. 회차 금액의 합은 청구액과 같아야 하고
 * (발행 경로가 먼저 막고 지연 제약 트리거 `inv_installment_sum_check` 가 커밋 때 다시 본다), 연체는
 * 「누적 입금이 못 채운 가장 이른 회차의 예정일」로 판정한다(`lib/exec-areas` `invDueSql`).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('inv_installment_seq_positive', 'seq >= 1')
@Check('inv_installment_amount_positive', 'amount > 0')
@Index('inv_installment_seq_uniq', ['invId', 'seq'], { unique: true })
@Index('inv_installment_due_uniq', ['invId', 'dueOn'], { unique: true })
@Entity({ name: 'inv_installment' })
export class InvInstallment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 청구서 — 지우면 일정도 함께 지워진다(ON DELETE CASCADE) */
  @Column({ type: 'bigint' })
  invId: number;

  /** 회차 — 1부터. 예정일 순서와 같다(발행 경로가 날짜 순으로 매긴다) */
  @Column({ type: 'smallint' })
  seq: number;

  /** 예정일 */
  @Column({ type: 'date' })
  dueOn: string;

  /** 그 회차의 금액 — 합이 청구액(`inv.amount`)이다 */
  @Column({ type: 'int' })
  amount: number;
}
