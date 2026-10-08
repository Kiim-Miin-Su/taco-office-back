/** @file-guide
 * 목적: suggestion 테이블 ORM 매핑 — Suggestion (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SUGGESTION — docs/contracts/db/erd.dbml v4.79와 대조합니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SUG_CAT_T_VALUES, SUG_STATE_T_VALUES } from './enums';

@Index(['staffId', 'createdAt'])
@Index('suggestion_staff_request_key_once', ['staffId', 'requestKey'], { unique: true, where: '"request_key" IS NOT NULL' })
@Index('suggestion_lesson_lookup', ['serId', 'onDate'], { where: '"ser_id" IS NOT NULL' })
@Entity({ name: 'suggestion' })
export class Suggestion {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  staffId: number;

  /** 수업 · 시급 · 스케줄 · 기타 (D-11 확정) */
  @Column({ type: 'enum', enum: SUG_CAT_T_VALUES, enumName: 'sug_cat_t' })
  category: 'lesson'|'pay'|'schedule'|'etc';

  @Column({ type: 'text' })
  body: string;

  /** 수업 팝업에서 보낸 건의의 exact 회차 identity. 일반 건의와 기존 행은 전부 null이다. */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'date', nullable: true })
  sourceDate: string | null;

  @Column({ type: 'bigint', nullable: true })
  readVersion: number | null;

  /** 제출 시각의 날짜·시간·과목·학생 이름. 이후 명단/수업 변경에도 보낸 내용을 보존한다. */
  @Column({ type: 'jsonb', nullable: true })
  lessonSnapshot: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  requestKey: string | null;

  /** 접수됨 · 확인 중 · 답변 완료 (D-12) */
  @Column({ type: 'enum', enum: SUG_STATE_T_VALUES, enumName: 'sug_state_t', default: 'open' })
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
