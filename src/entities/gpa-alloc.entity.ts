/** @file-guide
 * 목적: gpa_alloc 테이블 ORM 매핑 — GpaAlloc (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** GPA_ALLOC — 학생별 배정. gpaByStudent() = 배정 − 사용 − 대기 (N-13 채택). */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['cycleId', 'studentId'], { unique: true })
@Entity({ name: 'gpa_alloc' })
export class GpaAlloc {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  cycleId: number;

  @Column({ type: 'bigint' })
  studentId: number;

  /** 담당 코디네이터 */
  @Column({ type: 'bigint', nullable: true })
  coordId: number | null;

  /** 이 사이클 배정량 */
  @Column({ type: 'smallint' })
  points: number;
}
