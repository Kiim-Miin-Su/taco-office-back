/** @file-guide
 * 목적: lead_plan 테이블 ORM 매핑 — LeadPlan (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD_PLAN — 상담 배치안 초안 줄 (v4.47 · wave3 g3 23-16 · 24-07).
 *
 * 원본 §23 카드의 「SAT Reading 주2 · Rebecca」, §24 「당시 배치안」이 이 줄이다. 한 건의 줄은 통째로 바꿔 적는다(PUT).
 * **단가 칸이 없다** — 단가표(RATE)가 정본이라 여기 적으면 두 곳이 갈린다(D-R22). 읽을 때 적은 날의 단가표를 붙인다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'lead_plan' })
@Check('lead_plan_seq_range', 'seq BETWEEN 1 AND 8')
@Check('lead_plan_per_week_range', 'per_week BETWEEN 1 AND 7')
@Unique('lead_plan_lead_seq', ['leadId', 'seq'])
export class LeadPlan {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  leadId: number;

  /** 줄 차례 1~8 */
  @Column({ type: 'smallint' })
  seq: number;

  @Column({ type: 'varchar', length: 16 })
  kindKey: string;

  /** 과목 — 비우면 종류 이름으로 부른다 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  subKey: string | null;

  /** 주 N회 — 1~7. 요일·시각은 등록 확정 창에서 잡는다 */
  @Column({ type: 'smallint' })
  perWeek: number;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'bigint' })
  createdBy: number;

  /** 적은 때 — 「당시」 단가표를 고르는 기준일(KST) */
  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
