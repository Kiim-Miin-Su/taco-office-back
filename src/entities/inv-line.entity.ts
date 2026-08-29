/**
 * INV_LINE — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['invId', 'seq'])
@Entity({ name: 'inv_line' })
export class InvLine {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  invId: number;

  /** 과목 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  subKey: string | null;

  /** 표시용 — "고2 수학" */
  @Column({ type: 'varchar', length: 80 })
  label: string;

  /** 수강 횟수 — occ() 로 센 취소 아닌 회차 수. 사람이 세지 않는다 */
  @Column({ type: 'int' })
  count: number;

  @Column({ type: 'int' })
  unitPrice: number;

  /** count × unit_price — 저장 시점 스냅샷 */
  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'smallint', default: 0 })
  seq: number;
}
