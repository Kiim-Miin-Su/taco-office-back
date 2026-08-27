/**
 * LEAD — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'lead' })
export class Lead {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 등록되면 채워진다 */
  @Column({ type: 'bigint', nullable: true })
  studentId: number | null;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  school: string | null;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  /** 1차 · 2차대기 · 2차 · 보류 · 등록 · 실패 */
  @Column({ type: 'varchar', length: 16 })
  stage: string;

  /** 실패 시 중단 지점 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  stopAt: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
