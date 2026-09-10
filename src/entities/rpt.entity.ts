/** @file-guide
 * 목적: rpt 테이블 ORM 매핑 — Rpt (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * RPT — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['rptType', 'onDate'], { unique: true })
@Entity({ name: 'rpt' })
export class Rpt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** day | week | month (v2 — 3주기) */
  @Column({ type: 'varchar', length: 8 })
  rptType: string;

  /** day=그날 · week=그 주 월요일 · month=YYYY-MM-01 로 정규화 (D-R23) */
  @Column({ type: 'date' })
  onDate: string;

  /** 영역별 한 줄. 하나도 안 적으면 제출 불가 (D-R14) */
  @Column({ type: 'jsonb' })
  memo: Record<string, unknown>;

  /** draft | sent | ok | rej */
  @Column({ type: 'varchar', length: 8, default: 'draft' })
  state: string;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  rejectReason: string | null;
}
