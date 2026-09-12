/** @file-guide
 * 목적: lead_stage_log 테이블 ORM 매핑 — LeadStageLog (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD_STAGE_LOG — 상담 단계 도달 기록 (append-only · N-25 채택 · v2 §24).
 * 순서 보장은 id 단조 — «마지막 단계» 판정은 fail_from 명시값 → 이 로그 역순 → 미분류.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['leadId', 'id'])
@Entity({ name: 'lead_stage_log' })
export class LeadStageLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  leadId: number;

  @Column({ type: 'varchar', length: 16 })
  stage: string;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
