/** @file-guide
 * 목적: todo 테이블 ORM 매핑 — Todo (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * TODO — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, PrimaryGeneratedColumn } from 'typeorm';
import { TODO_SRC_T_VALUES } from './enums';

// W11 · N-86 (migration 1764600000000) — 등록 뒤 사후 관리 할 일. 출처가 상담이면 상담 건과 갈래가 함께 선다
@Check('todo_care_words', "care IS NULL OR care IN ('happycall','monthly')")
@Check('todo_lead_key', "((src)::text = 'lead') = (lead_id IS NOT NULL) AND (lead_id IS NULL) = (care IS NULL)")
@ForeignKey('lead', ['leadId'], ['id'], { name: 'todo_lead_id_fk', onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
@Entity({ name: 'todo' })
export class Todo {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  /** 준 사람 */
  @Column({ type: 'bigint', nullable: true })
  fromId: number | null;

  /** 받은 사람 */
  @Column({ type: 'bigint', nullable: true })
  toId: number | null;

  @Column({ type: 'date', nullable: true })
  dueOn: string | null;

  @Column({ type: 'boolean', default: false })
  done: boolean;

  @Column({ type: 'enum', enum: TODO_SRC_T_VALUES, enumName: 'todo_src_t', default: 'manual' })
  src: 'meeting'|'complaint'|'consulting'|'plan'|'manual'|'lesson'|'lead';

  @Column({ type: 'bigint', nullable: true })
  mtId: number | null;

  @Column({ type: 'bigint', nullable: true })
  cplId: number | null;

  @Column({ type: 'bigint', nullable: true })
  consId: number | null;

  @Column({ type: 'bigint', nullable: true })
  planId: number | null;

  /**
   * 회차에 걸린 지시 — §12 첫 줄 「대표 지시 할 일」.
   *
   * 키가 둘인 이유는 회차의 정체가 `(ser_id, on_date)` 이기 때문이다. `ser_occ.id` 는
   * 투영이라 쓰기마다 갈린다 (C82-b 원장). `onDate` 는 규칙이 원래 찍은 날이다.
   */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  /**
   * W11 · N-86 — 사후 관리 할 일이 걸린 상담 건. 상담 건이 지워지면 함께 지운다(그 건의 일이다 · 제품에는 상담을 지우는 길이 없다).
   * 해피콜은 상담 건마다 하나(`todo_lead_happycall_once`), 월간 상담은 같은 날 하나(`todo_lead_monthly_on`)다 — 등록 재시도에 중복이 서지 않는다.
   */
  @Column({ type: 'bigint', nullable: true })
  leadId: number | null;

  /** 사후 관리 갈래 — happycall(첫 실제 수업 + 7일) · monthly(첫 수업과 같은 날 매월) */
  @Column({ type: 'varchar', length: 12, nullable: true })
  care: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
