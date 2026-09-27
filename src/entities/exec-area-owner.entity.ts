/** @file-guide
 * 목적: exec_area_owner 테이블 ORM 매핑 — ExecAreaOwner (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * EXEC_AREA_OWNER — 대표 보고 영역마다 **고정 담당 한 명** (N-81 · 원문 §69 카드 메모 칸 위 이름 · 슬라이드 72 표).
 *
 * 영역 키는 `lib/exec-areas` 의 여섯이고 표의 CHECK 가 그 밖을 막는다. 담당을 바꾸는 사람은 대표 판정이다.
 * **처음엔 비어 있다** — 원문 표본 이름을 데이터로 넣지 않는다. 사람을 지우면 담당이 비고 행은 남는다(SET NULL).
 */
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Check('exec_area_owner_key_words', "area_key IN ('money', 'mkt', 'ops', 'consulting', 'complaint', 'lesson')")
@Entity({ name: 'exec_area_owner' })
export class ExecAreaOwner {
  @PrimaryColumn({ type: 'varchar', length: 12 })
  areaKey: string;

  /** 담당 — 비우면 아무도 정해지지 않은 영역이다 */
  @Column({ type: 'bigint', nullable: true })
  staffId: number | null;

  /** 마지막으로 정한 사람 — 비운 것도 정한 것이다 */
  @Column({ type: 'bigint' })
  setBy: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  setAt: Date;
}
