/** @file-guide
 * 목적: mfb 테이블 ORM 매핑 — Mfb (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * MFB — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// C53 두 제약을 W11 · N-29 ③(migration 1764600000000)이 넓혔다 — 보류는 담당 답변의 한 종류라 부모 코멘트를 든다
@Check('mfb_kind_chk', "kind IN ('comment','reply','hold')")
@Check('mfb_reply_needs_parent', "(kind IN ('reply','hold')) = (parent_id IS NOT NULL)")
@Entity({ name: 'mfb' })
export class Mfb {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  mktId: number | null;

  @Column({ type: 'bigint' })
  byId: number;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;

  /**
   * 쓸 때의 종류 — comment(대표 코멘트) · reply(담당자 답변) · hold(담당자 보류 · W11 N-29 ③). 역할로 되짚지 않는다 (C53).
   * 보류는 코멘트마다 하나다(`mfb_hold_once`) — 카드는 「확인 필요」로 남고 「고친 것 알리기」(reply)가 푼다.
   */
  @Column({ type: 'varchar', length: 8, default: 'comment' })
  kind: string;

  /** 답변 · 보류가 답하는 코멘트 — 코멘트면 null (C53) */
  @Column({ type: 'bigint', nullable: true })
  parentId: number | null;
}
