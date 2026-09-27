/** @file-guide
 * 목적: payout_bonus_rule 테이블 ORM 매핑 — PayoutBonusRule (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PAYOUT_BONUS_RULE — 강사료 **가산 규칙** (N-93 · D1 §4-12 · migration 1764900000000).
 *
 * 종류 셋 — `per_session` 한 번에(수업 종류마다) · `kinder_hourly` Kinder 시급에 더함 · `group_per_student` 그룹 한 명당.
 * 시급(WAGE)처럼 **새 줄로만 바꾼다**(적용일 소급 없음 · 지난 줄 불변). 셈은 `lib/payout-sheet` 의 한 함수가 한다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Check('payout_bonus_rule_kind_words', "kind IN ('per_session', 'kinder_hourly', 'group_per_student')")
@Check('payout_bonus_rule_kind_key_pair', "(kind = 'per_session') = (kind_key IS NOT NULL)")
@Check('payout_bonus_rule_amount_range', 'amount >= 0 AND amount <= 1000000')
@Entity({ name: 'payout_bonus_rule' })
export class PayoutBonusRule {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 20 })
  kind: string;

  /** 「한 번에」의 수업 종류 — 나머지 둘은 NULL */
  @Column({ type: 'varchar', length: 16, nullable: true })
  kindKey: string | null;

  /** 원 — 0 이면 그 날부터 가산을 멈춘다 */
  @Column({ type: 'int' })
  amount: number;

  /** 적용 시작일(그 날 수업부터) — 오늘보다 앞일 수 없다 */
  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'bigint' })
  setBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
