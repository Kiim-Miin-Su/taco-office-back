/** @file-guide
 * 목적: wrep 테이블 ORM 매핑 — Wrep (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * WREP — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * N-54 채택(W11 · migration 1764400000000) — 주간 묶음의 **사람이 쓴 총평만** 여기에 둔다.
 * 그 주(월~일)의 리포트 본문은 읽을 때 모은다(저장하지 않는다 — 학부모에게 나갈 글을 시스템이 짓지 않는다).
 * `body` = `{ summary, by, at }` 세 칸 · `week_of` = 그 주 월요일. 세 제약은 NOT VALID(옛 행은 검사하지 않는다 · N-25).
 */
@Index(['studentId', 'weekOf'], { unique: true })
@ForeignKey('stu', ['studentId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Check('wrep_week_monday', 'extract(isodow from "week_of") = 1')
@Check(
  'wrep_body_summary',
  `"body" IS NULL OR (jsonb_typeof("body") = 'object' AND COALESCE(jsonb_typeof("body"->'summary'), '') = 'string'`
  + ` AND char_length(btrim("body"->>'summary')) BETWEEN 1 AND 2000 AND COALESCE(jsonb_typeof("body"->'by'), '') = 'number'`
  + ` AND COALESCE(jsonb_typeof("body"->'at'), '') = 'string' AND ("body" - 'summary' - 'by' - 'at') = '{}'::jsonb)`,
)
@Entity({ name: 'wrep' })
export class Wrep {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  studentId: number;

  @Column({ type: 'date' })
  weekOf: string;

  /** `{ summary: 사람이 쓴 총평, by: 쓴 직원 id, at: 쓴 시각 ISO }` — 그 밖의 칸은 DB 가 거절한다 */
  @Column({ type: 'jsonb', nullable: true })
  body: Record<string, unknown> | null;
}
