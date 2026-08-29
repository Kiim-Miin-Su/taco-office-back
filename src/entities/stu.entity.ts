/**
 * STU — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'stu' })
export class Stu {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  grade: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  school: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  targetExam: string | null;

  @Column({ type: 'date', nullable: true })
  startedOn: string | null;

  /** 지도 강도 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  guidance: string | null;

  /** 수업 언어 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  lang: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
