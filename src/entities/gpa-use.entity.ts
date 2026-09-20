/** @file-guide
 * 목적: gpa_use 테이블 ORM 매핑 — GpaUse (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GPA_USE — 회차별 소비. ptOf() 가 읽고 gpTimeline() 이 잔여 막대를 그린다 (대기는 점선).
 * 배정을 넘기면 붉게 표시하고 추가 결제/다음 사이클 조정을 안내한다. 학부모 비공개 (D-R30 · N-13 채택).
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['cycleId', 'studentId', 'onDate'])
@Entity({ name: 'gpa_use' })
export class GpaUse {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  cycleId: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** kind='gpa' 회차 연결 (선택) */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'varchar', length: 8 })
  svcKey: string;

  /** GPASVC.point 스냅샷 — 규정이 바뀌어도 과거 소비는 그대로다 */
  @Column({ type: 'smallint' })
  points: number;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'smallint', nullable: true })
  startMin: number | null;

  @Column({ type: 'bigint', nullable: true })
  coordId: number | null;

  /** 기록지 */
  @Column({ type: 'text', nullable: true })
  noteUrl: string | null;

  /** wait | ok — 대기는 타임라인에 점선 */
  @Column({ type: 'varchar', length: 8, default: 'wait' })
  state: string;

  /**
   * 승인 도장 — 누가·언제 (migration 1761500000000).
   * `coord_id`(기록자)와 **같을 수 없다**: `gpa_use_no_self_approve`.
   * 시각과 사람은 짝이다: `gpa_use_approve_pair`. 옛 행은 둘 다 NULL(N-25 보정 0).
   */
  @Column({ type: 'bigint', nullable: true })
  approvedBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;
}
