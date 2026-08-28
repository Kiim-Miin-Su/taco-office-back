/**
 * MKT — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'mkt' })
export class Mkt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 채널 7종 */
  @Column({ type: 'varchar', length: 20 })
  channel: string;

  /** 항목 7종 */
  @Column({ type: 'varchar', length: 20 })
  item: string;

  @Column({ type: 'text', nullable: true })
  url: string | null;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;
}
