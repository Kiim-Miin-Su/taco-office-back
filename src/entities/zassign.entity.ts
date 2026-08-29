/**
 * ZASSIGN — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'zassign' })
export class Zassign {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'bigint', nullable: true })
  excId: number | null;

  @Column({ type: 'bigint' })
  zaccId: number;

  /** 고정 배정 vs 변동 */
  @Column({ type: 'boolean', default: true })
  fixed: boolean;
}
