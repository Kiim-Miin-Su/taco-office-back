/**
 * ENR — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'enr' })
export class Enr {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 16 })
  kindKey: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  subKey: string | null;

  /** 회차 */
  @Column({ type: 'smallint', nullable: true })
  sessions: number | null;

  @Column({ type: 'date', nullable: true })
  startedOn: string | null;

  @Column({ type: 'date', nullable: true })
  endedOn: string | null;
}
