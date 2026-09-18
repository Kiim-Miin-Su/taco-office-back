/** @file-guide
 * 목적: ser_stu 테이블 ORM 매핑 — SerStu (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SER_STU — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Entity, PrimaryColumn, Column, ForeignKey, Check } from 'typeorm';

// D3-b2b 수동 보강: 재생성 시 migration 13 / DBML 12참조와 함께 보존한다.
@ForeignKey('ser', ['serId'], ['id'], { name: 'ser_stu_ser_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'ser_stu_student_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
// C94-c (v4.30 · migration 1760900000000): 명단에 기간 — 「아주 빼기」 대신 to_date 를 적어 지난 회차의 명단을 지키고(N-50 ①),
// 그 뒤 회차는 시간표·§54·청구서·단가 구간에서 빠진다 (lib/sql.serStuOn 한 곳). from_date 는 등록 확정(C91)의 자리.
@Check('ser_stu_range', '"from_date" IS NULL OR "to_date" IS NULL OR "to_date" >= "from_date"')
@Entity({ name: 'ser_stu' })
export class SerStu {
  @PrimaryColumn({ type: 'bigint' })
  serId: number;

  @PrimaryColumn({ type: 'bigint' })
  studentId: number;

  /** 이 날부터 명단에 있다 — NULL 이면 처음부터 */
  @Column({ type: 'date', nullable: true })
  fromDate: string | null;

  /** 이 날까지 명단에 있다 — NULL 이면 끝까지. 수강 종료가 적는다 (C94-c) */
  @Column({ type: 'date', nullable: true })
  toDate: string | null;
}
