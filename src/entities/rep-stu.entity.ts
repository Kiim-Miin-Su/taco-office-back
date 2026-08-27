/**
 * REP_STU — docs/contracts/db/erd.dbml v4.1 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'rep_stu' })
export class RepStu {
  @PrimaryColumn({ type: 'bigint' })
  repId: number;

  @PrimaryColumn({ type: 'bigint' })
  studentId: number;

  /** 그룹 리포트 학생별 코멘트 — v26 40자 이상 */
  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @Column({ type: 'boolean', default: true })
  deliver: boolean;
}
