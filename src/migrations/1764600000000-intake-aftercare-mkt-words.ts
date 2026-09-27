/** @file-guide
 * 목적: W11 C2 — 등록 뒤 사후 관리 할 일(todo.src='lead' · lead_id · care · lead.first_lesson_on)과 §59·§60 어휘(mkt 어휘 CHECK · memo · mfb 보류)를 DB 에 둔다.
 * 책임/재사용: 칸 · 제약 · 색인만 더한다. 옛 행은 보정하지 않는다(N-25). 되돌리면 잃는 값이 있으면 down 이 멈춘다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W11 · C2 (대표 위임 「결정 대기도 권고안으로 채택」 2026-09-26).
 *
 * ① **N-86 — 사후 관리를 담당의 할 일로** (DQ2 권장안). 등록 확정이 해피콜(첫 실제 수업 + 7일)과 첫 월간 상담을 상담 담당의 할 일로
 *    만들고, 월간은 끝나면 다음 달 하나를 잇는다. 할 일은 미래 예약 여러 개를 함께 담는다 — 접촉 원장의 `next_on` 한 칸으로는
 *    해피콜과 월간을 함께 못 담는다(S13).
 *    - `todo_src_t += 'lead'` · `todo.lead_id`(FK · 상담 건이 지워지면 함께 · 제품에는 지우는 길이 없다) · `todo.care`(happycall | monthly).
 *    - `todo_lead_key` — 출처가 상담이면 상담 건과 갈래가 **함께** 선다. 새 enum 값은 이 트랜잭션 안에서 쓸 수 없으므로(PostgreSQL)
 *      식은 `src::text` 로 견준다.
 *    - 해피콜은 상담 건마다 하나 · 월간은 같은 날 하나(부분 유니크) — **등록 재시도에 중복이 서지 않는다**(S13 완료 기준).
 *    - `lead.first_lesson_on` — 등록 순간의 첫 실제 수업일(월간의 「같은 날」 기준). 회차는 투영이라 뒤에 흔들린다.
 * ② **N-29 — §59 어휘 · 메모 · §60 보류**.
 *    - `mkt_channel_words` · `mkt_item_words` — 원문 컷의 넷 · 넷에 **옛 행의 코드**를 더한 목록(이관 없음 · 옛 이름 그대로 읽힌다).
 *    - `mkt.memo` — 카드 제목 아래 메모 한 줄(MMEMO = MKT 의 한 칸 · D-R22).
 *    - `mfb.kind += 'hold'` — 보류는 담당 답변의 한 종류라 부모 코멘트를 든다(C53 의 두 제약을 넓힌다) · 코멘트마다 하나(`mfb_hold_once`).
 *
 * 새 제약은 전부 `NOT VALID` 다 — 새 행만 지킨다(C64 선례). 옛 행을 채우거나 고치지 않는다(N-25).
 */
export class IntakeAftercareMktWords1764600000000 implements MigrationInterface {
  name = 'IntakeAftercareMktWords1764600000000';

  public async up(q: QueryRunner): Promise<void> {
    /* ── ① N-86 사후 관리 할 일 ───────────────────────────────────── */
    await q.query(`ALTER TYPE todo_src_t ADD VALUE IF NOT EXISTS 'lead'`);
    await q.query(`ALTER TABLE todo ADD COLUMN lead_id bigint`);
    await q.query(`ALTER TABLE todo ADD CONSTRAINT todo_lead_id_fk FOREIGN KEY (lead_id) REFERENCES lead(id) ON DELETE CASCADE`);
    await q.query(`ALTER TABLE todo ADD COLUMN care varchar(12)`);
    await q.query(`COMMENT ON COLUMN todo.lead_id IS 'W11 N-86 — 사후 관리 할 일이 걸린 상담 건'`);
    await q.query(`COMMENT ON COLUMN todo.care IS 'W11 N-86 — 사후 관리 갈래: happycall(첫 실제 수업 + 7일) · monthly(첫 수업과 같은 날 매월)'`);
    await q.query(`ALTER TABLE todo ADD CONSTRAINT todo_care_words
      CHECK (care IS NULL OR care IN ('happycall','monthly')) NOT VALID`);
    await q.query(`ALTER TABLE todo ADD CONSTRAINT todo_lead_key
      CHECK (((src)::text = 'lead') = (lead_id IS NOT NULL) AND (lead_id IS NULL) = (care IS NULL)) NOT VALID`);
    await q.query(`CREATE INDEX todo_lead_idx ON todo (lead_id) WHERE lead_id IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX todo_lead_happycall_once ON todo (lead_id) WHERE care = 'happycall'`);
    await q.query(`CREATE UNIQUE INDEX todo_lead_monthly_on ON todo (lead_id, due_on) WHERE care = 'monthly'`);
    await q.query(`ALTER TABLE lead ADD COLUMN first_lesson_on date`);
    await q.query(`COMMENT ON COLUMN lead.first_lesson_on IS 'W11 N-86 — 등록 확정 때 잡은 첫 실제 수업일(해피콜 +7일 · 월간 같은 날의 기준)'`);

    /* ── ② N-29 §59 어휘 · 메모 · §60 보류 ───────────────────────────── */
    await q.query(`ALTER TABLE mkt ADD COLUMN memo varchar(120)`);
    await q.query(`COMMENT ON COLUMN mkt.memo IS 'W11 N-29 ② — 카드 제목 아래 메모 한 줄(MMEMO)'`);
    await q.query(`ALTER TABLE mkt ADD CONSTRAINT mkt_channel_words
      CHECK (channel IN ('kakao','naver_ad','instagram','naver_blog','naver','daangn','youtube','referral','flyer')) NOT VALID`);
    await q.query(`ALTER TABLE mkt ADD CONSTRAINT mkt_item_words
      CHECK (item IN ('reply','ad','video','post','blog','biz','channel','word','print')) NOT VALID`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_kind_chk`);
    await q.query(`ALTER TABLE mfb ADD CONSTRAINT mfb_kind_chk CHECK (kind IN ('comment','reply','hold')) NOT VALID`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_reply_needs_parent`);
    await q.query(`ALTER TABLE mfb ADD CONSTRAINT mfb_reply_needs_parent
      CHECK ((kind IN ('reply','hold')) = (parent_id IS NOT NULL)) NOT VALID`);
    await q.query(`CREATE UNIQUE INDEX mfb_hold_once ON mfb (parent_id) WHERE kind = 'hold'`);
    await q.query(`COMMENT ON COLUMN mfb.kind IS '쓸 때의 종류 — comment(대표 코멘트) · reply(담당자 답변) · hold(담당자 보류). 역할로 되짚지 않는다'`);
  }

  /**
   * 되돌리면 **잃는 값**이 있으면 멈춘다 — 사후 관리 할 일의 상담 연결 · 첫 수업일 · 메모 · 보류 글.
   * 옮기거나 지운 뒤 다시 되돌린다. `todo_src_t` 의 'lead' 는 남는다 — PostgreSQL 은 enum 값을 지우지 못한다.
   */
  public async down(q: QueryRunner): Promise<void> {
    const [row] = (await q.query(
      `SELECT (SELECT count(*) FROM todo WHERE lead_id IS NOT NULL OR care IS NOT NULL OR (src)::text = 'lead')::int AS care,
              (SELECT count(*) FROM lead WHERE first_lesson_on IS NOT NULL)::int AS first_lesson,
              (SELECT count(*) FROM mkt WHERE memo IS NOT NULL)::int AS memo,
              (SELECT count(*) FROM mfb WHERE kind = 'hold')::int AS hold`,
    )) as Array<{ care: number; first_lesson: number; memo: number; hold: number }>;
    const lost = Object.entries(row).filter(([, n]) => Number(n) > 0);
    if (lost.length) {
      throw new Error(`1764600000000 을 되돌리면 값이 사라진다 — ${lost.map(([k, n]) => `${k} ${n}행`).join(' · ')}. 먼저 옮기거나 지운 뒤 되돌린다`);
    }
    await q.query(`DROP INDEX IF EXISTS mfb_hold_once`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_reply_needs_parent`);
    await q.query(`ALTER TABLE mfb ADD CONSTRAINT mfb_reply_needs_parent CHECK ((kind = 'reply') = (parent_id IS NOT NULL)) NOT VALID`);
    await q.query(`ALTER TABLE mfb DROP CONSTRAINT IF EXISTS mfb_kind_chk`);
    await q.query(`ALTER TABLE mfb ADD CONSTRAINT mfb_kind_chk CHECK (kind IN ('comment','reply')) NOT VALID`);
    await q.query(`COMMENT ON COLUMN mfb.kind IS '쓸 때의 종류 — comment(대표 코멘트) · reply(담당자 답변). 역할로 되짚지 않는다'`);
    await q.query(`ALTER TABLE mkt DROP CONSTRAINT IF EXISTS mkt_item_words`);
    await q.query(`ALTER TABLE mkt DROP CONSTRAINT IF EXISTS mkt_channel_words`);
    await q.query(`ALTER TABLE mkt DROP COLUMN IF EXISTS memo`);
    await q.query(`ALTER TABLE lead DROP COLUMN IF EXISTS first_lesson_on`);
    await q.query(`DROP INDEX IF EXISTS todo_lead_monthly_on`);
    await q.query(`DROP INDEX IF EXISTS todo_lead_happycall_once`);
    await q.query(`DROP INDEX IF EXISTS todo_lead_idx`);
    await q.query(`ALTER TABLE todo DROP CONSTRAINT IF EXISTS todo_lead_key`);
    await q.query(`ALTER TABLE todo DROP CONSTRAINT IF EXISTS todo_care_words`);
    await q.query(`ALTER TABLE todo DROP COLUMN IF EXISTS care`);
    await q.query(`ALTER TABLE todo DROP CONSTRAINT IF EXISTS todo_lead_id_fk`);
    await q.query(`ALTER TABLE todo DROP COLUMN IF EXISTS lead_id`);
  }
}
