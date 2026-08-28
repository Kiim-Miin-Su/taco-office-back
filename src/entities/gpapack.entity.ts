/**
 * GPAPACK — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'gpapack' })
export class Gpapack {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** exam(시험 대비) | self(자습) — 두 가지만 받는다 */
  @Column({ type: 'varchar', length: 12 })
  packType: string;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  state: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
