/**
 * KIND — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { KIND_GRP_T_VALUES } from './enums';

@Entity({ name: 'kind' })
export class Kind {
  /** class · mock · gpa · study · consult · diagx · consulting · meeting */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  key: string;

  @Column({ type: 'varchar', length: 30 })
  name: string;

  @Column({ type: 'char', length: 7 })
  color: string;

  /** 정원 */
  @Column({ type: 'smallint' })
  cap: number;

  /** 묶음 분류 */
  @Column({ type: 'enum', enum: KIND_GRP_T_VALUES })
  grp: 'lesson'|'intake'|'meeting';

  /** true 인 종류만 리포트 대상 (D-4) */
  @Column({ type: 'boolean', default: false })
  rep: boolean;

  /** ⚠️ 쓰지 않는다 — 양식은 5칸 하나뿐 (D-R40). 컬럼만 남겨 둔다 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  repForm: string | null;

  @Column({ type: 'smallint', nullable: true })
  sort: number | null;
}
