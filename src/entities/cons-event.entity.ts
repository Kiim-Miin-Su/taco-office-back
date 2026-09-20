/** @file-guide
 * 목적: §30 계약 워크플로의 전달/파일/피드백/수납/보관·회차·항목 체크 이벤트를 영구 감사한다.
 * 책임/재사용: 현재 상태를 대신하지 않으며 CONS/각 원장의 쓰기와 같은 트랜잭션에서만 추가한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'cons_event' })
@Index(['consId', 'createdAt'])
@Check('cons_event_type_check', "event_type IN ('created','share_changed','file_added','file_removed','feedback_added','feedback_resolved','parent_delivered','payment_added','archived','session_added','session_written','closed','item_done','item_undone')")
export class ConsEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) consId: number;
  @Column({ type: 'varchar', length: 24 }) eventType: string;
  @Column({ type: 'bigint', nullable: true }) refId: number | null;
  @Column({ type: 'bigint' }) byId: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
