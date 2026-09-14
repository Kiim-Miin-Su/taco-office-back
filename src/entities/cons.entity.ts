/** @file-guide
 * 목적: cons 테이블 ORM 매핑 — Cons (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * CONS — docs/contracts/db/erd.dbml v4.11 대조. TBO-47C CHECK/단계 타입 보강.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CONS_SHARE_T_VALUES } from './enums';
import type { ConsultingStage } from '../modules/consulting/consulting.rules';

@Entity({ name: 'cons' })
@Check('cons_stage_check', "stage IN ('contract','running','done')")
@Check('cons_contract_step_check', 'contract_step BETWEEN 1 AND 5')
@Check('cons_paid_stage_check', "stage = 'contract' OR contract_step IS NOT DISTINCT FROM 5")
@Check('cons_sessions_check', 'sessions > 0')
@Check('cons_requester_check', "requester IS NULL OR requester IN ('mother','father')")
@Check('cons_dates_check', 'start_on IS NULL OR end_on IS NULL OR start_on <= end_on')
@Check('cons_deleted_pair_check', '(deleted_at IS NULL) = (deleted_by IS NULL)')
export class Cons {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 종류 10종 */
  @Column({ type: 'varchar', length: 20 })
  consType: string;

  /** contract | running | done */
  @Column({ type: 'varchar', length: 12 })
  stage: ConsultingStage;

  /** 계약 5단계 — 계약서 → 피드백 → 학부모 전달 → 서명본 → 수납 */
  @Column({ type: 'smallint', nullable: true })
  contractStep: number | null;

  @Column({ type: 'int', nullable: true })
  amount: number | null;

  @Column({ type: 'smallint', nullable: true })
  sessions: number | null;

  /** §29 계약 시작일. 레거시 행은 null을 보존한다. */
  @Column({ type: 'date', nullable: true })
  startOn: string | null;

  @Column({ type: 'date', nullable: true })
  endOn: string | null;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  /** §29 요청자 — 학부모 연락처/외부 발송 대상 정보는 이 값으로 추정하지 않는다. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  requester: 'mother'|'father'|null;

  /** csCan() 목록 필터 · csCanFull() 내용 접근 */
  @Column({ type: 'enum', enum: CONS_SHARE_T_VALUES, enumName: 'cons_share_t', default: 'all' })
  share: 'all'|'money_only'|'picked'|'private';

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;

  /** 영구 보관 원칙: DELETE API는 실제 삭제 대신 이 두 칸을 함께 기록한다. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  deletedBy: number | null;
}
