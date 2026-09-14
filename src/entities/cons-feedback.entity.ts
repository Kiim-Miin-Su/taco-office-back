/** @file-guide
 * 목적: §30 계약서 피드백과 해결 증거를 append-only에 가깝게 보존한다.
 * 책임/재사용: 본문/작성/해결 사실만 소유하고 컨설팅 단계 계산은 service가 담당한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'cons_feedback' })
@Index(['consId', 'createdAt'])
@Check('cons_feedback_resolved_pair_check', '(resolved_at IS NULL) = (resolved_by IS NULL)')
export class ConsFeedback {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) consId: number;
  @Column({ type: 'varchar', length: 2000 }) body: string;
  @Column({ type: 'bigint' }) createdBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @Column({ type: 'bigint', nullable: true }) resolvedBy: number | null;
}
