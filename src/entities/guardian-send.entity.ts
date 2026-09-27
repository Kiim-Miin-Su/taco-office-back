/** @file-guide
 * 목적: guardian_send 테이블 ORM 매핑 — GuardianSend (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * GUARDIAN_SEND — 보호자 발송 원장 (DQ3 · N-42 · v4.42). 보호자×채널 **시도 한 번에 한 줄**, append-only.
 *
 * `to_masked` 는 **가린 받는 곳**이다 — 원문 주소·번호는 원장에도 로그에도 두지 않는다.
 * `not_configured` 는 설정이 없어 시도하지 않았다는 사실이다(보낸 척하지 않는다). PNOTI.sent_at 은 `sent` 가
 * 하나라도 있을 때만 찍힌다. `(request_key, guardian_id, channel)` 유니크가 재시도의 두 번째 발송을 막는다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Index(['studentId', 'sentAt'])
@Index('guardian_send_pnoti_idx', ['pnotiId'], { where: '"pnoti_id" IS NOT NULL' })
@Index('guardian_send_wrep_idx', ['wrepId'], { where: '"wrep_id" IS NOT NULL' })
@Unique('guardian_send_once', ['requestKey', 'guardianId', 'channel'])
@ForeignKey('pnoti', ['pnotiId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('guardian', ['guardianId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('staff', ['sentBy'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('wrep', ['wrepId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('guardian_send_one_source', '"pnoti_id" IS NULL OR "wrep_id" IS NULL')
@Check('guardian_send_channel', "channel IN ('email','sms')")
@Check('guardian_send_status', "status IN ('sent','failed','not_configured')")
@Entity({ name: 'guardian_send' })
export class GuardianSend {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 한 번의 「보내기」 — 재시도는 같은 키로 와서 앞선 결과를 돌려받는다 */
  @Column({ type: 'uuid' })
  requestKey: string;

  /** §43 회차 학부모 안내(PNOTI parent)에서 보냈으면 그 줄 — 안내문 등 다른 곳에서 보냈으면 null */
  @Column({ type: 'bigint', nullable: true })
  pnotiId: number | null;

  /**
   * 주간 묶음(N-54 · W11)에서 보냈으면 그 묶음(`wrep`) — 회차 안내와 동시에 가리키지 않는다(`guardian_send_one_source`).
   * migration 1764400000000 · 옛 행은 NULL.
   */
  @Column({ type: 'bigint', nullable: true })
  wrepId: number | null;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'bigint' })
  guardianId: number;

  /** email | sms — notify/sender.SEND_CHANNELS */
  @Column({ type: 'varchar', length: 10 })
  channel: string;

  /** 가린 받는 곳 — ab***@example.com · 010-****-1234 */
  @Column({ type: 'varchar', length: 80 })
  toMasked: string;

  /** sent | failed | not_configured */
  @Column({ type: 'varchar', length: 16 })
  status: string;

  /** 공급자 식별자 (메일 messageId · SENS requestId) */
  @Column({ type: 'varchar', length: 200, nullable: true })
  providerId: string | null;

  /** 실패·미설정 사유 — 받는 곳 원문은 가려서 적는다 */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'bigint' })
  sentBy: number;

  /** 시도한 시각 — 실패·미설정 줄도 이 시각을 갖는다 */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;
}
