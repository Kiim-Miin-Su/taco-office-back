/** @file-guide
 * 목적: book_category 테이블 ORM 매핑 — BookCategory (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * BOOK_CATEGORY — §39 교재 소분류 코드표 (N-47 채택 · W11).
 *
 * 과목 하나에 매달린다. 원문 §39 컷에 **보이는 것만** 마이그레이션이 넣는다(Reading · ELA · Grammar ·
 * Speaking & Interview · Writing · General Math · Pre-Algebra · Biology) — 안 보이는 소분류는 짓지 않는다.
 * `(subject_key, key)` 유일 — LIB 의 두 칸 FK 가 「고른 과목의 소분류」만 받게 하는 짝이다.
 */
import { Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Unique('book_category_subject_uq', ['subjectKey', 'key'])
@Entity({ name: 'book_category' })
export class BookCategory {
  @PrimaryColumn({ type: 'varchar', length: 30 })
  key: string;

  @Column({ type: 'varchar', length: 20 })
  subjectKey: string;

  /** 원문 낱말 그대로 (Reading …) */
  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'smallint' })
  sort: number;
}
