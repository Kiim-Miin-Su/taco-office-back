/** @file-guide
 * 목적: schedule-time-contract.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/** 역사 SQL은 runtime 도메인 함수를 import하지 않는다. entity와의 일치는 회귀에서 검증한다. */
export const TIME_CHECKS = [
  {
    "table": "ser",
    "name": "ser_time_check",
    "expression": "start_min BETWEEN 0 AND 1439 AND end_min BETWEEN 1 AND 1440 AND end_min - start_min BETWEEN 10 AND 480"
  },
  {
    "table": "exc",
    "name": "exc_time_check",
    "expression": "(start_min IS NULL OR start_min BETWEEN 0 AND 1439) AND (end_min IS NULL OR end_min BETWEEN 1 AND 1440) AND (start_min IS NULL OR end_min IS NULL OR end_min - start_min BETWEEN 10 AND 480)"
  },
  {
    "table": "ser_occ",
    "name": "ser_occ_time_check",
    "expression": "NOT isempty(span) AND NOT lower_inf(span) AND NOT upper_inf(span) AND isfinite(lower(span)) AND isfinite(upper(span)) AND lower_inc(span) AND NOT upper_inc(span) AND date_trunc('minute', lower(span) AT TIME ZONE 'Asia/Seoul') = lower(span) AT TIME ZONE 'Asia/Seoul' AND date_trunc('minute', upper(span) AT TIME ZONE 'Asia/Seoul') = upper(span) AT TIME ZONE 'Asia/Seoul' AND upper(span) - lower(span) BETWEEN interval '10 minutes' AND interval '480 minutes' AND upper(span) <= (((lower(span) AT TIME ZONE 'Asia/Seoul')::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')"
  }
] as const;
export class ScheduleTimeContract1757800000000 implements MigrationInterface {
  name = 'ScheduleTimeContract1757800000000';
  async preflight(q: QueryRunner): Promise<Record<string, number>> {
    const [counts] = await q.query('SELECT ' + TIME_CHECKS.map(c =>
      `(SELECT count(*)::int FROM ${c.table} WHERE (${c.expression}) IS NOT TRUE) AS ${c.name}`
    ).join(', ')) as Record<string, number>[];
    return counts;
  }
  async up(q: QueryRunner): Promise<void> {
    const counts = await this.preflight(q);
    if (Object.values(counts).some(n => n !== 0)) throw new Error(`Schedule time preflight failed: ${JSON.stringify(counts)}`);
    for (const c of TIME_CHECKS) await q.query(`ALTER TABLE ${c.table} ADD CONSTRAINT ${c.name} CHECK (${c.expression})`);
  }
  async down(q: QueryRunner): Promise<void> {
    for (const c of [...TIME_CHECKS].reverse()) await q.query(`ALTER TABLE ${c.table} DROP CONSTRAINT ${c.name}`);
  }
}
