/** @file-guide
 * 목적: gpa_cycle 테이블 ORM 매핑 — GpaCycle (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** GPA_CYCLE — 4주 사이클. 이월 없음: 닫히면 잔여 포인트는 소멸한다 (D-R29 · N-13 채택). */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['fromDate', 'toDate'])
@Entity({ name: 'gpa_cycle' })
export class GpaCycle {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** «3차 사이클 …» 표기용 순번 */
  @Column({ type: 'smallint' })
  no: number;

  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'date' })
  toDate: string;

  @Column({ type: 'boolean', default: false })
  closed: boolean;
}
