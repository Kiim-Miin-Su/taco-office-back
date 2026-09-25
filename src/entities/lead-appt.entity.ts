/** @file-guide
 * 목적: lead_appt 테이블 ORM 매핑 — LeadAppt (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD_APPT — 상담 2차 · 진단고사 일정 (v4.47 · wave3 g3 23-15).
 *
 * 원본 §23 2차 대기 카드의 「진단 08-24 10:00 · 본원 [미생성]」「2차 08-26 14:30 · 본원 [미생성]」 두 줄이다. 한 건에 종류마다 한 줄.
 * 「스케줄에 N건 만들기」가 시간표 회차(SER)를 만들어 `serId` 로 잇는다 — 「미생성」은 그 연결이 없다는 뜻이다.
 * 시간표에서 회차를 지우면 연결만 풀린다(ON DELETE SET NULL).
 */
import { Check, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'lead_appt' })
@Check('lead_appt_kind_words', "kind IN ('diag','second')")
@Check('lead_appt_mode_words', "mode IN ('offline','online')")
@Check('lead_appt_time_range', 'start_min >= 0 AND end_min <= 1440 AND end_min > start_min')
@Check('lead_appt_online_no_room', "mode = 'offline' OR room_id IS NULL")
@Unique('lead_appt_lead_kind', ['leadId', 'kind'])
export class LeadAppt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  leadId: number;

  /** diag(진단고사) | second(2차 상담) */
  @Column({ type: 'varchar', length: 8 })
  kind: string;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'smallint' })
  startMin: number;

  @Column({ type: 'smallint' })
  endMin: number;

  /** offline | online — 온라인이면 강의실이 없다 */
  @Column({ type: 'varchar', length: 8, default: 'offline' })
  mode: string;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  /** 시간표 회차 — 만들기 전(「미생성」)은 NULL */
  @Column({ type: 'bigint', nullable: true })
  serId: number | null;

  @Column({ type: 'bigint' })
  createdBy: number;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
