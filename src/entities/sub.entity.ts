/**
 * SUB — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'sub' })
export class Sub {
  /** map_read · sat_math · writing … 21종 */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  key: string;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'char', length: 7 })
  color: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'smallint', nullable: true })
  sort: number | null;
}
