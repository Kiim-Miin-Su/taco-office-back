/**
 * CONS_SESS — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'cons_sess' })
export class ConsSess {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  consId: number;

  @Column({ type: 'smallint' })
  seq: number;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'text', nullable: true })
  who: string | null;

  @Column({ type: 'text', nullable: true })
  what: string | null;

  @Column({ type: 'text', nullable: true })
  why: string | null;

  @Column({ type: 'text', nullable: true })
  how: string | null;

  /** 회차 기록 시 스케줄이 생긴다 */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;
}
