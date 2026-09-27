/** @file-guide
 * 목적: plan_pick 테이블 ORM 매핑 — PlanPick (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PLAN_PICK — 지정 공개 기획을 볼 수 있게 **지정된 사람** (N-72 · migration 1764700000000).
 *
 * 컨설팅의 `cons_pick` 과 같은 모양이다. 누가 볼 수 있는가의 판정은 `lib/plan-words` 의 `planCan` 한 곳이고
 * 이 표는 그 판정의 재료 하나(지정됐는가)만 갖는다. 기획이 지워지면 함께 사라진다(CASCADE).
 */
import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'plan_pick' })
export class PlanPick {
  @PrimaryColumn({ type: 'bigint' })
  planId: number;

  @PrimaryColumn({ type: 'bigint' })
  staffId: number;
}
