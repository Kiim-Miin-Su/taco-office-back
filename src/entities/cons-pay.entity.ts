/** @file-guide
 * 목적: cons_pay 테이블 ORM 매핑 — ConsPay (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * CONS_PAY — §28 컨설팅 납부 기록 (원문 `CONS.pay[]` · C58).
 *
 * 청구서 입금(`pay`)과 **다른 표**다. 컨설팅 납부는 청구서를 거치지 않고도 들어온다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['consId', 'paidOn'])
@Entity({ name: 'cons_pay' })
export class ConsPay {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  consId: number;

  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'date' })
  paidOn: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  memo: string | null;

  @Column({ type: 'bigint' })
  byId: number;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
