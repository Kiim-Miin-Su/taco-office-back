/**
 * RSEND — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'rsend' })
export class Rsend {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'date' })
  onDate: string;

  /** 학생 단위로 묶어 보낸 리포트들 */
  @Column({ type: 'jsonb' })
  repIds: number[];

  @Column({ type: 'varchar', length: 10 })
  channel: string;

  /** 발송 원문 스냅샷 */
  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz', default: () => "now()" })
  sentAt: Date;

  @Column({ type: 'bigint' })
  sentBy: number;

  /** HTTP 재시도와 더블클릭이 발송 이력을 중복 생성하지 않게 한다. */
  @Column({ type: 'uuid', unique: true })
  requestKey: string;

  /** null이면 최초 발송, 값이 있으면 그 RSEND 스냅샷의 재발송이다. */
  @Column({ type: 'bigint', nullable: true })
  sourceSendId: number | null;
}
