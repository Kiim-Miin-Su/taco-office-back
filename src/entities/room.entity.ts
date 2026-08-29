/**
 * ROOM — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['branch', 'name'], { unique: true })
@Entity({ name: 'room' })
export class Room {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 강남 · 송도 · 제주 */
  @Column({ type: 'varchar', length: 20 })
  branch: string;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'smallint', nullable: true })
  capacity: number | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
