/** @file-guide
 * 목적: education-grade.entity.ts — EDUCATION_GRADE 테이블 ORM 매핑 (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기 metadata를 함께 대조한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * EDUCATION_GRADE — docs/contracts/db/erd.dbml v4.59 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Index(['educationSystem', 'sort'], { unique: true })
@Entity({ name: 'education_grade' })
export class EducationGrade {
  /** US/GB/KR/OTHER · 거주 국가와 독립 */
  @PrimaryColumn({ type: 'varchar', length: 5 })
  educationSystem: string;

  /** US G1~G12, GB Yr1~Yr13, KR E/M/H, OTHER repeat 등 명시 46조합 */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  code: string;

  @Column({ type: 'varchar', length: 30 })
  labelKo: string;

  @Column({ type: 'smallint' })
  sort: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
