/** @file-guide
 * 목적: mtrec 테이블 ORM 매핑 — Mtrec (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * MTREC — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'mtrec' })
export class Mtrec {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 기획 · 컨설팅 · 마케팅 · 개발 · 일반 5종 */
  @Column({ type: 'varchar', length: 12 })
  mtType: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  title: string | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'jsonb', nullable: true })
  preFiles: Record<string, unknown> | null;

  /** 속기록 */
  @Column({ type: 'text', nullable: true })
  minutes: string | null;

  /** 속기록을 마지막으로 저장한 시각 — `createdAt`(회의 행이 생긴 시각)과 다르다 (C57) */
  @Column({ type: 'timestamptz', nullable: true })
  minutesAt: Date | null;

  /** 속기록을 마지막으로 저장한 사람 (C57) */
  @Column({ type: 'bigint', nullable: true })
  minutesBy: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;

  /**
   * 그 회의가 놓인 **시간표의 회차** (C96 · v4.35).
   *
   * 시각·강의실·온라인은 여기 담지 않는다 — `SER` 가 이미 갖고 있고 `ser_occ` 의 EXCLUDE 가
   * 겹침을 막는다. 네 칸을 여기 새기면 같은 사실이 두 곳에 살고(D-R22) 겹침은 아무도 안 막는다.
   * `ON DELETE SET NULL` — 회차가 사라져도 속기록·참석은 「그 회의가 있었다」는 기록으로 남는다.
   * 옛 행은 NULL 이다(N-25 — 어느 회차였는지 아무도 모른다).
   */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;
}
