/** @file-guide
 * 목적: enr 테이블 ORM 매핑 — Enr (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * ENR — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'enr' })
export class Enr {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'varchar', length: 16 })
  kindKey: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  subKey: string | null;

  /** 회차 */
  @Column({ type: 'smallint', nullable: true })
  sessions: number | null;

  @Column({ type: 'date', nullable: true })
  startedOn: string | null;

  @Column({ type: 'date', nullable: true })
  endedOn: string | null;
}
