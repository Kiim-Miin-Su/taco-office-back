/** @file-guide
 * 목적: ser_occ 테이블 ORM 매핑 — SerOcc (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SER_OCC — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn, Check } from 'typeorm';

@Index(['serId', 'onDate'])
// D3-d2 수동 CHECK metadata: migration14와 함께 보존/검증한다.
@Check('ser_occ_time_check', "NOT isempty(span) AND NOT lower_inf(span) AND NOT upper_inf(span) AND isfinite(lower(span)) AND isfinite(upper(span)) AND lower_inc(span) AND NOT upper_inc(span) AND date_trunc('minute', lower(span) AT TIME ZONE 'Asia/Seoul') = lower(span) AT TIME ZONE 'Asia/Seoul' AND date_trunc('minute', upper(span) AT TIME ZONE 'Asia/Seoul') = upper(span) AT TIME ZONE 'Asia/Seoul' AND upper(span) - lower(span) BETWEEN interval '10 minutes' AND interval '480 minutes' AND upper(span) <= (((lower(span) AT TIME ZONE 'Asia/Seoul')::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')")
@Entity({ name: 'ser_occ' })
export class SerOcc {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  serId: number;

  @Column({ type: 'date' })
  onDate: string;

  @Column({ type: 'bigint', nullable: true })
  teacherId: number | null;

  @Column({ type: 'bigint', nullable: true })
  roomId: number | null;

  @Column({ type: 'bigint', nullable: true })
  zaccId: number | null;

  @Column({ type: 'boolean', default: false })
  canceled: boolean;

  @Column({ type: 'tstzrange' })
  span: string;
}
