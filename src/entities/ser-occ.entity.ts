/**
 * SER_OCC — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['serId', 'onDate'])
@Entity({ name: 'ser_occ' })
export class SerOcc {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  serId: number;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  @Column({ type: 'bigint', nullable: true })
  zaccId: number | null;

  @Column({ type: 'boolean', default: false })
  canceled: boolean;

  @Column({ type: 'tstzrange' })
  span: string;
}
