/**
 * MTREC — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'mtrec' })
export class Mtrec {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 기획 · 컨설팅 · 마케팅 · 개발 · 일반 5종 */
  @Column({ type: 'varchar', length: 12 })
  mtType: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  title: string | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'jsonb', nullable: true })
  preFiles: Record<string, unknown> | null;

  /** 속기록 */
  @Column({ type: 'text', nullable: true })
  minutes: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
