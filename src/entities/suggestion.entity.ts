/**
 * SUGGESTION — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SUG_CAT_T_VALUES, SUG_STATE_T_VALUES } from './enums';

@Index(['staffId', 'createdAt'])
@Entity({ name: 'suggestion' })
export class Suggestion {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  /** 수업 · 시급 · 스케줄 · 기타 (D-11 확정) */
  @Column({ type: 'enum', enum: SUG_CAT_T_VALUES })
  category: 'lesson'|'pay'|'schedule'|'etc';

  @Column({ type: 'text' })
  body: string;

  /** 접수됨 · 확인 중 · 답변 완료 (D-12) */
  @Column({ type: 'enum', enum: SUG_STATE_T_VALUES, default: 'open' })
  state: 'open'|'reviewing'|'done';

  @Column({ type: 'text', nullable: true })
  reply: string | null;

  @Column({ type: 'bigint', nullable: true })
  replyBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  replyAt: Date | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
