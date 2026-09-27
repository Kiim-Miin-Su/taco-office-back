/** @file-guide
 * 목적: acct_privacy 테이블 ORM 매핑 — AcctPrivacy (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * ACCT_PRIVACY — 회계 탭 줄의 **두 비공개 스위치** (N-94 · 원문 §53 · §55 컷 탭 줄 오른쪽 · migration 1764900000000).
 *
 * `wage` 시급 비공개 · `consulting` 컨설팅 비공개. 켜면 그 줄 금액은 비공개 열람(canHide)만 보고, 합계는 그대로다.
 * 행이 없으면 꺼짐으로 읽는다(시드 초기화가 표를 비울 수 있다). 판정 · 가림은 `lib/acct-privacy` 한 곳.
 */
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Check('acct_privacy_key_words', "key IN ('wage', 'consulting')")
@Check('acct_privacy_set_at_with_by', 'set_by IS NULL OR set_at IS NOT NULL')
@Entity({ name: 'acct_privacy' })
export class AcctPrivacy {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  key: string;

  @Column({ type: 'boolean', default: false })
  private: boolean;

  /** 마지막으로 켜고 끈 사람 — 운영 전환이 계정을 지우면 빈다 */
  @Column({ type: 'bigint', nullable: true })
  setBy: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  setAt: Date | null;
}
