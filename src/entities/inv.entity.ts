/**
 * INV — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { INV_STATE_T_VALUES } from './enums';

@Index(['studentId', 'yearMonth'])
@Index(['state', 'dueOn'])
@Entity({ name: 'inv' })
export class Inv {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** 수강 내역에서 자동 생성 가능 */
  @Column({ type: 'bigint', nullable: true })
  enrId: number | null;

  @Column({ type: 'varchar', length: 7 })
  yearMonth: string;

  /** 청구 종류 6종 — 종류마다 결제 수단이 제한된다 */
  @Column({ type: 'varchar', length: 16 })
  invType: string;

  @Column({ type: 'varchar', length: 80 })
  title: string;

  /** 들어와야 할 금액. 회계 화면에서 placeholder 로 쓰인다 */
  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  @Column({ type: 'enum', enum: INV_STATE_T_VALUES, default: 'draft' })
  state: 'draft'|'sent'|'unpaid'|'partial'|'paid'|'void';

  @Column({ type: 'date', nullable: true })
  issuedOn: string | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  createdBy: number | null;

  /** state=partial 일 때 지금까지 받은 합 (D-R37) */
  @Column({ type: 'int', default: 0 })
  paidAmount: number;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /** 입금 증빙 — Vercel Blob (D-R42) */
  @Column({ type: 'text', nullable: true })
  proofUrl: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  memo: string | null;
}
