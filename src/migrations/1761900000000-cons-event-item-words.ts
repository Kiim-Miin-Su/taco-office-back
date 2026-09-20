/** @file-guide
 * 목적: 1761900000000-cons-event-item-words.ts (migration)
 * 책임/재사용: 영속 스키마 변경만 단계적으로 적용한다. 기존 데이터 추정 보정 없이 제약/컬럼을 추가하고 실패 시 중단한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/** 지금 쓰는 낱말 — `up` 이 새기는 집합이자 `down` 이 되돌릴 기준이다 */
const BEFORE = [
  'created', 'share_changed', 'file_added', 'file_removed', 'feedback_added',
  'feedback_resolved', 'parent_delivered', 'payment_added', 'archived',
  'session_added', 'session_written', 'closed',
] as const;
const ADDED = ['item_done', 'item_undone'] as const;

const check = (words: readonly string[]): string =>
  `CHECK ("event_type" IN (${words.map((w) => `'${w}'`).join(',')}))`;

/**
 * 컨설팅 항목 체크/해제에 흔적을 남긴다 — S7 (전수 검수 §7 「흔적이 없는 쓰기」).
 *
 * **해제가 지우개였다.** `toggleItem` 의 해제 갈래는 `done_by`·`done_at` 을 **NULL 로 되돌린다** —
 * 누가 언제 그 항목을 끝냈다고 했는지가 행에서 통째로 사라지고, 어느 원장에도 줄이 없었다.
 * 필수 항목은 컨설팅 **종료를 막는 조건**(`CONS_ITEMS_LEFT`)이라 그 체크는 업무 판단이고,
 * 지워지면 나중에 「왜 종료가 열렸나」를 되짚을 데가 없다.
 *
 * **`log` 가 아니라 `cons_event` 다.** 이 파일의 다른 열한 쓰기가 전부 `cons_event` 에 남긴다 —
 * 한 자리만 `log` 로 보내면 「이 건에 누가 무엇을 했나」의 답이 두 표로 갈리고, `cons_event_cons_created_idx`
 * 가 이미 예고하는 활동 내역 화면이 항목 체크만 조용히 빠뜨린다. 낱말을 더하는 길은 C95 가 이미 냈다.
 *
 * 켬·끔을 **두 낱말로** 나눈 것은 `ref_id`(=`cons_item.id`)만으로는 어느 쪽인지 알 수 없어서다 —
 * append-only 원장에서 마지막 줄이 곧 지금 상태여야 한다.
 *
 * **기존 행 보정 0** (N-25) — 지난 체크는 `done_by`·`done_at` 이 남아 있으면 그 행이 전부이고,
 * 해제된 것은 아무도 모른다. 없는 줄을 지어내지 않는다.
 */
export class ConsEventItemWords1761900000000 implements MigrationInterface {
  name = 'ConsEventItemWords1761900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`ALTER TABLE "cons_event" ADD CONSTRAINT "cons_event_type_check" ${check([...BEFORE, ...ADDED])}`);
  }

  /**
   * 되돌리기는 **좁히는 일**이라 데이터를 먼저 본다 — 새 낱말 줄이 남아 있으면 CHECK 가 붙지 않는다.
   * 그 줄을 지우지 않는다(감사 원장이다). **세어서 멈추고** 사람이 정한다.
   */
  public async down(q: QueryRunner): Promise<void> {
    const [{ n }] = (await q.query(
      `SELECT count(*)::int AS n FROM "cons_event" WHERE "event_type" = ANY($1::text[])`, [[...ADDED]],
    )) as Array<{ n: number }>;
    if (Number(n) > 0) {
      throw new Error(
        `cons_event 에 ${ADDED.join('·')} 줄이 ${n}건 남아 있어 제약을 좁힐 수 없습니다 — ` +
        '그 줄을 어떻게 할지(보존·이관·삭제) 정한 뒤 다시 내리세요.',
      );
    }
    await q.query(`ALTER TABLE "cons_event" DROP CONSTRAINT IF EXISTS "cons_event_type_check"`);
    await q.query(`ALTER TABLE "cons_event" ADD CONSTRAINT "cons_event_type_check" ${check(BEFORE)}`);
  }
}
