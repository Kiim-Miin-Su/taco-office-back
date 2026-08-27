/**
 * CONS — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CONS_SHARE_T_VALUES } from './enums';

@Entity({ name: 'cons' })
export class Cons {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 종류 10종 */
  @Column({ type: 'varchar', length: 20 })
  consType: string;

  /** contract | running | done */
  @Column({ type: 'varchar', length: 12 })
  stage: string;

  /** 계약 5단계 — 계약서 → 피드백 → 학부모 전달 → 서명본 → 수납 */
  @Column({ type: 'smallint', nullable: true })
  contractStep: number | null;

  @Column({ type: 'int', nullable: true })
  amount: number | null;

  @Column({ type: 'smallint', nullable: true })
  sessions: number | null;

  @Column({ type: 'date', nullable: true })
  endOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  /** csCan() 목록 필터 · csCanFull() 내용 접근 */
  @Column({ type: 'enum', enum: CONS_SHARE_T_VALUES, default: 'all' })
  share: 'all'|'money_only'|'picked'|'private';

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
