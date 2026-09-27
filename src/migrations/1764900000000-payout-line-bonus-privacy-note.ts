/** @file-guide
 * 목적: 1764900000000-payout-line-bonus-privacy-note.ts — PayoutLineBonusPrivacyNote1764900000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 옛 행을 추정해 고치지 않고, 어긋난 행이 있으면 세어서 멈춘다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W11 M2 — 강사료 정산의 근거 줄 · 가산 규칙 · 회계 비공개 스위치 · 인수인계 메모 (N-36 · N-51 · N-93 · N-94).
 *
 * ① **정산 근거 줄 `payout_line`** (N-36 ① · N-51). 지급 확정 트랜잭션이 회차마다 한 줄을 남긴다 —
 *    그 순간의 시급(unit_rate 스냅숏) · 시수 · 금액(amount = 시급×시간) · 가산(bonus) · 지각 차감(cut).
 *    **한 회차는 한 번만 지급된다** — `(ser_id, on_date)` 유일(`payout_line_ser_on_uniq`). 확정 뒤에 쓴 리포트는
 *    다음 미확정 달의 줄(`correction = true`)로 들어가고, 이 유일이 두 번 주는 것을 표에서 막는다.
 *    회차 키는 둘 다 필수다(옛 설계의 nullable 은 쓰는 코드가 없었다 — 표는 비어 있다 · 비어 있지 않으면 세어서 멈춘다).
 *    줄은 정산(payout)의 일부라 정산 행을 지우려면 줄부터 지워야 한다(RESTRICT) — 굳힌 근거가 조용히 사라지지 않는다.
 * ② **가산 규칙 `payout_bonus_rule`** (N-93 · D1 §4-12). 종류 셋(한 번에 · Kinder 시급에 더함 · 그룹 한 명당) × 적용일.
 *    시급(WAGE)·단가표처럼 **새 줄로만 바꾼다** — 지난 줄은 고치지도 지우지도 않는다. 같은 자리 · 같은 날 두 줄은 유일로 막는다.
 *    「한 번에」는 수업 종류마다(kind_key 필수), 나머지 둘은 종류 없이(kind_key NULL) — `payout_bonus_rule_kind_key_pair`.
 *    **처음엔 비어 있다** — D1 금액을 데이터로 넣지 않는다(대표가 화면에서 적는다 · 화면은 D1 값을 미리 채워 보여 준다).
 * ③ **회계 비공개 스위치 `acct_privacy`** (N-94). 두 줄(`wage` 시급 비공개 · `consulting` 컨설팅 비공개) · 처음엔 꺼짐.
 *    누가 · 언제 켰는지(`set_by` · `set_at`). 운영 전환이 계정을 지워 `set_by` 가 비어도 시각은 남을 수 있다
 *    (`acct_privacy_set_at_with_by` — 사람이 있으면 시각도 있다).
 * ④ **인수인계 메모 `note`** (N-36 ②). 표는 있었고 제약이 없었다 — 학생 · 회차 FK 와 빈 글 금지를 새긴다.
 *    쓴 사람(`author_id`)은 계정 참조 목록(`lib/staff-refs` STAFF_SOFT_REFS)이 FK 없는 칸으로 관리한다 — 그대로 둔다.
 *
 * down 은 이 migration 이후에만 생기는 값(근거 줄 · 가산 규칙 · 켠 스위치)이 있으면 **멈춘다** — 돈의 근거를 조용히 버리지 않는다.
 */
export class PayoutLineBonusPrivacyNote1764900000000 implements MigrationInterface {
  name = 'PayoutLineBonusPrivacyNote1764900000000';

  private static async count(q: QueryRunner, sql: string): Promise<number> {
    const [r] = (await q.query(sql)) as Array<{ n: string | number }>;
    return Number(r?.n ?? 0);
  }

  /** 어긋난 옛 행이 있으면 고치지 않고 센 뒤 멈춘다 (N-25 · 추정 보정 금지) */
  private static async refuse(q: QueryRunner, what: string, sql: string): Promise<void> {
    const n = await PayoutLineBonusPrivacyNote1764900000000.count(q, sql);
    if (n > 0) throw new Error(`payout-line-bonus-privacy-note: ${what} ${n}행 — 고치지 않고 멈춥니다(사람이 확인)`);
  }

  public async up(q: QueryRunner): Promise<void> {
    const self = PayoutLineBonusPrivacyNote1764900000000;

    /* ① payout_line — 먼저 센다 */
    await self.refuse(q, '회차 키(ser_id · on_date)가 빈 정산 줄', `SELECT count(*) AS n FROM payout_line WHERE ser_id IS NULL OR on_date IS NULL`);
    await self.refuse(q, '같은 회차가 두 번 든 정산 줄',
      `SELECT count(*) AS n FROM (SELECT 1 FROM payout_line GROUP BY ser_id, on_date HAVING count(*) > 1) d`);
    await self.refuse(q, '없는 정산을 가리키는 줄', `SELECT count(*) AS n FROM payout_line l WHERE NOT EXISTS (SELECT 1 FROM payout p WHERE p.id = l.payout_id)`);
    await self.refuse(q, '없는 규칙을 가리키는 줄', `SELECT count(*) AS n FROM payout_line l WHERE NOT EXISTS (SELECT 1 FROM ser s WHERE s.id = l.ser_id)`);
    await self.refuse(q, '없는 수업 종류를 가리키는 줄',
      `SELECT count(*) AS n FROM payout_line l WHERE l.kind_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kind k WHERE k.key = l.kind_key)`);
    await self.refuse(q, '음수 금액 · 시수 줄', `SELECT count(*) AS n FROM payout_line WHERE hours < 0 OR unit_rate < 0 OR amount < 0 OR cut < 0`);

    await q.query(`ALTER TABLE payout_line ADD COLUMN bonus int NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE payout_line ADD COLUMN bonus_detail jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`ALTER TABLE payout_line ADD COLUMN correction boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE payout_line ALTER COLUMN ser_id SET NOT NULL`);
    await q.query(`ALTER TABLE payout_line ALTER COLUMN on_date SET NOT NULL`);
    await q.query(`ALTER TABLE payout_line ADD CONSTRAINT payout_line_payout_fk FOREIGN KEY (payout_id) REFERENCES payout(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE payout_line ADD CONSTRAINT payout_line_ser_fk FOREIGN KEY (ser_id) REFERENCES ser(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE payout_line ADD CONSTRAINT payout_line_kind_fk FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE RESTRICT`);
    await q.query(
      `ALTER TABLE payout_line ADD CONSTRAINT payout_line_nonneg
         CHECK (hours >= 0 AND unit_rate >= 0 AND amount >= 0 AND cut >= 0 AND bonus >= 0)`,
    );
    await q.query(`ALTER TABLE payout_line ADD CONSTRAINT payout_line_bonus_detail_array CHECK (jsonb_typeof(bonus_detail) = 'array')`);
    await q.query(`CREATE UNIQUE INDEX payout_line_ser_on_uniq ON payout_line (ser_id, on_date)`);
    await q.query(`CREATE INDEX payout_line_payout_idx ON payout_line (payout_id)`);
    await q.query(`COMMENT ON COLUMN payout_line.amount IS '시급×시간(분 단위 정수 절사) — 가산 · 차감은 따로 (N-36)'`);
    await q.query(`COMMENT ON COLUMN payout_line.bonus IS '가산 합(N-93) — bonus_detail 이 종류별 내역'`);
    await q.query(`COMMENT ON COLUMN payout_line.correction IS '보정 줄 — 확정된 달의 회차를 다음 미확정 달에 얹어 지급 (N-51)'`);

    /* ② payout_bonus_rule */
    await q.query(`
      CREATE TABLE payout_bonus_rule (
        id bigserial PRIMARY KEY,
        kind varchar(20) NOT NULL,
        kind_key varchar(16),
        amount int NOT NULL,
        from_date date NOT NULL,
        reason text,
        set_by bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payout_bonus_rule_kind_words CHECK (kind IN ('per_session', 'kinder_hourly', 'group_per_student')),
        CONSTRAINT payout_bonus_rule_kind_key_pair CHECK ((kind = 'per_session') = (kind_key IS NOT NULL)),
        CONSTRAINT payout_bonus_rule_amount_range CHECK (amount >= 0 AND amount <= 1000000),
        CONSTRAINT payout_bonus_rule_kind_fk FOREIGN KEY (kind_key) REFERENCES kind(key) ON DELETE RESTRICT,
        CONSTRAINT payout_bonus_rule_set_by_fk FOREIGN KEY (set_by) REFERENCES staff(id) ON DELETE RESTRICT
      )`);
    await q.query(`CREATE UNIQUE INDEX payout_bonus_rule_slot_day_uniq ON payout_bonus_rule (kind, COALESCE(kind_key, ''), from_date)`);
    await q.query(
      `COMMENT ON TABLE payout_bonus_rule IS '강사료 가산 규칙 — 새 줄로만 바꾼다(지난 줄 불변 · 적용일 소급 없음). 처음엔 비어 있다 (N-93 · D1 §4-12)'`,
    );

    /* ③ acct_privacy */
    await q.query(`
      CREATE TABLE acct_privacy (
        key varchar(16) PRIMARY KEY,
        private boolean NOT NULL DEFAULT false,
        set_by bigint,
        set_at timestamptz,
        CONSTRAINT acct_privacy_key_words CHECK (key IN ('wage', 'consulting')),
        CONSTRAINT acct_privacy_set_at_with_by CHECK (set_by IS NULL OR set_at IS NOT NULL),
        CONSTRAINT acct_privacy_set_by_fk FOREIGN KEY (set_by) REFERENCES staff(id) ON DELETE RESTRICT
      )`);
    await q.query(`INSERT INTO acct_privacy (key, private) VALUES ('wage', false), ('consulting', false)`);
    await q.query(
      `COMMENT ON TABLE acct_privacy IS '회계 탭 줄의 두 비공개 스위치 — 켜면 줄 금액은 비공개 열람(canHide)만 본다 · 합계는 그대로 (N-94)'`,
    );

    /* ④ note */
    await self.refuse(q, '없는 학생을 가리키는 메모', `SELECT count(*) AS n FROM note n WHERE NOT EXISTS (SELECT 1 FROM stu s WHERE s.id = n.student_id)`);
    await self.refuse(q, '없는 규칙을 가리키는 메모', `SELECT count(*) AS n FROM note n WHERE n.ser_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ser s WHERE s.id = n.ser_id)`);
    await self.refuse(q, '빈 메모', `SELECT count(*) AS n FROM note WHERE length(btrim(body)) = 0`);
    await q.query(`ALTER TABLE note ADD CONSTRAINT note_student_fk FOREIGN KEY (student_id) REFERENCES stu(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE note ADD CONSTRAINT note_ser_fk FOREIGN KEY (ser_id) REFERENCES ser(id) ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE note ADD CONSTRAINT note_body_present CHECK (length(btrim(body)) > 0 AND length(body) <= 2000)`);
    await q.query(
      `COMMENT ON TABLE note IS '인수인계 메모 — 관리자 · 매니저가 §79 학생 트래킹에서 한 줄씩 더하고(고치기 · 지우기 없음) 그 학생을 맡은 강사가 수업 안내 학생 카드에서 읽는다. 학부모에게 나가지 않는다 (N-36 ②)'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    const self = PayoutLineBonusPrivacyNote1764900000000;
    // 돈의 근거 · 켠 스위치 · 가산 규칙은 이 migration 이후에만 생긴다 — 있으면 버리지 않고 멈춘다
    await self.refuse(q, '정산 근거 줄', `SELECT count(*) AS n FROM payout_line`);
    await self.refuse(q, '가산 규칙', `SELECT count(*) AS n FROM payout_bonus_rule`);
    await self.refuse(q, '켜져 있는 비공개 스위치', `SELECT count(*) AS n FROM acct_privacy WHERE private`);

    await q.query(`ALTER TABLE note DROP CONSTRAINT IF EXISTS note_body_present`);
    await q.query(`ALTER TABLE note DROP CONSTRAINT IF EXISTS note_ser_fk`);
    await q.query(`ALTER TABLE note DROP CONSTRAINT IF EXISTS note_student_fk`);
    await q.query(`DROP TABLE IF EXISTS acct_privacy`);
    await q.query(`DROP TABLE IF EXISTS payout_bonus_rule`);
    await q.query(`DROP INDEX IF EXISTS payout_line_payout_idx`);
    await q.query(`DROP INDEX IF EXISTS payout_line_ser_on_uniq`);
    await q.query(`ALTER TABLE payout_line DROP CONSTRAINT IF EXISTS payout_line_bonus_detail_array`);
    await q.query(`ALTER TABLE payout_line DROP CONSTRAINT IF EXISTS payout_line_nonneg`);
    await q.query(`ALTER TABLE payout_line DROP CONSTRAINT IF EXISTS payout_line_kind_fk`);
    await q.query(`ALTER TABLE payout_line DROP CONSTRAINT IF EXISTS payout_line_ser_fk`);
    await q.query(`ALTER TABLE payout_line DROP CONSTRAINT IF EXISTS payout_line_payout_fk`);
    await q.query(`ALTER TABLE payout_line ALTER COLUMN on_date DROP NOT NULL`);
    await q.query(`ALTER TABLE payout_line ALTER COLUMN ser_id DROP NOT NULL`);
    await q.query(`ALTER TABLE payout_line DROP COLUMN IF EXISTS correction`);
    await q.query(`ALTER TABLE payout_line DROP COLUMN IF EXISTS bonus_detail`);
    await q.query(`ALTER TABLE payout_line DROP COLUMN IF EXISTS bonus`);
  }
}
