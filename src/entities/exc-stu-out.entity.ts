/** @file-guide
 * 목적: exc_stu_out 테이블 ORM 매핑 — ExcStuOut (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * EXC_STU_OUT — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Entity, PrimaryColumn, ForeignKey } from 'typeorm';

// D3-b2b 수동 보강: 재생성 시 migration 13 / DBML 12참조와 함께 보존한다.
@ForeignKey('exc', ['excId'], ['id'], { name: 'exc_stu_out_exc_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'exc_stu_out_student_id_fk', onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'exc_stu_out' })
export class ExcStuOut {
  @PrimaryColumn({ type: 'bigint' })
  excId: number;

  @PrimaryColumn({ type: 'bigint' })
  studentId: number;
}
