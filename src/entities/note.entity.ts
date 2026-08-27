/**
 * NOTE — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['studentId', 'createdAt'])
@Entity({ name: 'note' })
export class Note {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'bigint' })
  authorId: number;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
