/** @file-guide
 * 목적: payout_line 테이블 ORM 매핑 — PayoutLine (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PAYOUT_LINE — 지급 확정이 남기는 **회차 한 줄** (N-36 ① · N-51 · migration 1764900000000).
 *
 * 확정 트랜잭션이 그 순간의 계산을 굳힌다 — 시급 스냅숏(unit_rate) · 시수 · 금액(시급×시간) · 가산 · 지각 차감.
 * 한 회차는 한 번만 지급된다(`payout_line_ser_on_uniq`). 확정 뒤에 쓴 리포트의 회차는 다음 미확정 달의
 * 보정 줄(`correction`)로 들어간다. 줄을 읽는 쪽은 `lib/payout-sheet` 하나다(확정된 달의 근거).
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('payout_line_nonneg', 'hours >= 0 AND unit_rate >= 0 AND amount >= 0 AND cut >= 0 AND bonus >= 0')
@Index('payout_line_ser_on_uniq', ['serId', 'onDate'], { unique: true })
@Index('payout_line_payout_idx', ['payoutId'])
@Entity({ name: 'payout_line' })
export class PayoutLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  payoutId: number;

  @Column({ type: 'bigint' })
  serId: number;

  /** 회차의 원래 날짜 키(EXC 키) — 옮긴 회차도 같은 키다 */
  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  kindKey: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 2 })
  hours: string;

  /** 수업일 기준 시급 스냅샷 — 이력이 정정돼도 안 흔들린다 */
  @Column({ type: 'int' })
  unitRate: number;

  /** 시급×시간(분 단위 정수 절사) — 가산 · 차감은 따로 */
  @Column({ type: 'int' })
  amount: number;

  /** 리포트 지각 차감 (D-R32) */
  @Column({ type: 'int', default: 0 })
  cut: number;

  /** 가산 합 (N-93) */
  @Column({ type: 'int', default: 0 })
  bonus: number;

  /** 가산 내역 — [{ kind, amount }] */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  bonusDetail: Array<{ kind: string; amount: number }>;

  /** 보정 줄 — 확정된 달의 회차를 다음 미확정 달에 얹어 지급 (N-51) */
  @Column({ type: 'boolean', default: false })
  correction: boolean;
}
