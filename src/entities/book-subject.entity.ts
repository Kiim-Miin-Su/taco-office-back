/** @file-guide
 * 목적: book_subject 테이블 ORM 매핑 — BookSubject (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * BOOK_SUBJECT — §39 교재 과목 코드표 (N-47 채택 · W11 · DBML 조각은 기록 impl9-w11-3 §7).
 *
 * 원문 §39 컷의 넷(English · Math · Science · Social Studies)만 마이그레이션이 넣는다 — 화면에서 만드는 자리는 없다.
 * 시간표 과목(`SUB`)과는 **다른 축**이다. 교재가 캘린더 과목 옆에 서지 않게 따로 둔다.
 */
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Check('book_subject_color_hex', "color ~ '^#[0-9A-Fa-f]{6}$'")
@Entity({ name: 'book_subject' })
export class BookSubject {
  /** english · math · science · social_studies */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  key: string;

  /** 원문 낱말 그대로 (English …) */
  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** 칩 점 · 묶음 머리 · 소분류 글자 색 — 컷 실측 */
  @Column({ type: 'char', length: 7 })
  color: string;

  @Column({ type: 'smallint' })
  sort: number;
}
