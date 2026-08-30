import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `SER.rrule` 의 형식을 하나로 모은다.
 *
 * 시드는 `FREQ=WEEKLY;BYDAY=1,4` 로 썼는데 규칙을 읽는 쪽(`lib/recurrence.ts`)은
 * `WEEKLY:MO,TH` 를 읽는다. 두 형식이 한 컬럼에 섞여 있었고,
 * `parseRule('FREQ=WEEKLY;BYDAY=1,4')` 는 **days: [] 를 돌려준다** —
 * 즉 그 규칙은 어떤 날짜에도 맞지 않는다. 회차가 조용히 전부 사라지는 자리였다.
 *
 * 읽는 쪽에 파서를 하나 더 붙이지 않고 **저장 형식을 옮긴다.**
 * `formatRule()` 이 이미 정식 표기를 만들고 85개 어서션이 그 형식을 고정한다 —
 * 진실을 하나로 두려면 그쪽이 기준이어야 한다.
 *
 * 근본 원인은 `erd.dbml` 이 형식을 안 적어 둔 것이다. 같은 커밋에서 주석을 채웠다.
 */
export class RruleFormat1756500000000 implements MigrationInterface {
  name = 'RruleFormat1756500000000';

  private static readonly DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  public async up(q: QueryRunner): Promise<void> {
    const rows = (await q.query(
      `SELECT id, rrule FROM ser WHERE rrule LIKE 'FREQ=%'`,
    )) as Array<{ id: string; rrule: string }>;

    for (const r of rows) {
      const m = /BYDAY=([0-9,]+)/i.exec(r.rrule);
      const nums = m ? m[1].split(',').map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6) : [];
      const next = nums.length
        ? `WEEKLY:${nums.sort((a, b) => a - b).map((n) => RruleFormat1756500000000.DOW[n]).join(',')}`
        : 'ONCE';
      await q.query(`UPDATE ser SET rrule = $1 WHERE id = $2`, [next, r.id]);
    }
  }

  /**
   * 되돌리기는 **하지 않는다.** 옛 형식은 읽는 쪽이 해석하지 못하므로,
   * 되돌리면 그 순간부터 회차가 사라진다. 내려갈 일이 있으면 사람이 판단한다.
   */
  public async down(): Promise<void> {
    throw new Error(
      'rrule 형식은 되돌리지 않습니다 — 옛 형식(FREQ=…)은 recurrence.ts 가 읽지 못해 회차가 전부 사라집니다.',
    );
  }
}
