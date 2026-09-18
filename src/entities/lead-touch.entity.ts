/** @file-guide
 * 목적: lead_touch 테이블 ORM 매핑 — LeadTouch (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD_TOUCH — 상담 사후 관리 접촉 원장 (append-only · N-44 결정 · C90 · v4.34).
 * 누가(by_id) · 언제(at) · 어떻게(kind) · 한 줄(note) · 다음은 언제(next_on).
 * 단계 전이 로그(LEAD_STAGE_LOG)와 섞지 않는다 — 두 뜻이 한 표에서 갈린다.
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['leadId', 'id'])
@Check('lead_touch_kind_words', "kind IN ('call','kakao','sms','visit','book','noshow','memo')")
@Check('lead_touch_note_present', 'length(btrim(note)) > 0')
@Entity({ name: 'lead_touch' })
export class LeadTouch {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  leadId: number;

  /** call | kakao | sms | visit | book(상담 예약) | noshow(예약 불참) | memo — 낱말은 lib/intake-words */
  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'text' })
  note: string;

  /** 다음 접촉·상담 예정일 — book 이면 상담 날짜. 「사후 관리 임박·밀림」과 「상담 오늘·지남」은 이 칸으로 센다 */
  @Column({ type: 'date', nullable: true })
  nextOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;
}
