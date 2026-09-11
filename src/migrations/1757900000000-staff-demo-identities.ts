/** @file-guide
 * 목적: staff-demo-identities.ts (migration)
 * 책임/재사용: 변경 당시 SQL을 고정하고 기존 행을 자동 보정/삭제하지 않는다. preflight·up/down·실제 DB 검증과 운영 적용을 구분한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 시드 핵심 4인을 실조직 실명으로 (2026-09-12 확정) — 대표 김민선(불변) ·
 * 관리자 김민수(구 박관리) · 매니저 김범준(구 이수현) · 강사 이다현(구 김서영).
 * **교수실장 직함은 존재하지 않는다** — title 도 함께 지운다.
 *
 * 데이터 마이그레이션이다: 스키마는 그대로 두고, 이메일(로그인 키)은 바꾸지 않으며,
 * 이름 가드(AND name=...)로 이미 새 시드로 만들어진 DB 에서는 0행 갱신이 된다.
 * cons_sess.who 는 시드가 심은 데모 문구라 사람 이름만 치환한다.
 */
const RENAMES = [
  { email: 'admin@tnacademy.kr', from: '박관리', to: '김민수', title: null },
  { email: 'head@tnacademy.kr', from: '이수현', to: '김범준', title: '매니저' },
  { email: 't01@tnacademy.kr', from: '김서영', to: '이다현', title: null },
] as const;

export class StaffDemoIdentities1757900000000 implements MigrationInterface {
  name = 'StaffDemoIdentities1757900000000';

  async preflight(q: QueryRunner): Promise<Record<string, number>> {
    const [counts] = await q.query(
      `SELECT
         (SELECT count(*)::int FROM staff WHERE email = 'admin@tnacademy.kr' AND name = '박관리') AS old_admin,
         (SELECT count(*)::int FROM staff WHERE email = 'head@tnacademy.kr' AND name = '이수현') AS old_head,
         (SELECT count(*)::int FROM staff WHERE email = 't01@tnacademy.kr' AND name = '김서영') AS old_t01,
         (SELECT count(*)::int FROM staff WHERE title = '교수실장') AS stale_title,
         (SELECT count(*)::int FROM cons_sess WHERE who LIKE '%이수현%' OR who LIKE '%김서영%') AS stale_who`,
    ) as Record<string, number>[];
    return counts;
  }

  async up(q: QueryRunner): Promise<void> {
    for (const r of RENAMES) {
      await q.query(
        `UPDATE staff SET name = $1${r.title ? ', title = $4' : ''} WHERE email = $2 AND name = $3`,
        r.title ? [r.to, r.email, r.from, r.title] : [r.to, r.email, r.from],
      );
    }
    // 어떤 경로로 남았든 교수실장 직함은 전부 매니저로 — 직함 자체가 없다.
    await q.query(`UPDATE staff SET title = '매니저' WHERE title = '교수실장'`);
    await q.query(`UPDATE cons_sess SET who = replace(who, '이수현', '김범준') WHERE who LIKE '%이수현%'`);
    await q.query(`UPDATE cons_sess SET who = replace(who, '김서영', '이다현') WHERE who LIKE '%김서영%'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE cons_sess SET who = replace(who, '이다현', '김서영') WHERE who LIKE '%이다현%'`);
    await q.query(`UPDATE cons_sess SET who = replace(who, '김범준', '이수현') WHERE who LIKE '%김범준%'`);
    await q.query(`UPDATE staff SET name = '김서영' WHERE email = 't01@tnacademy.kr' AND name = '이다현'`);
    await q.query(`UPDATE staff SET name = '이수현', title = '교수실장' WHERE email = 'head@tnacademy.kr' AND name = '김범준'`);
    await q.query(`UPDATE staff SET name = '박관리' WHERE email = 'admin@tnacademy.kr' AND name = '김민수'`);
  }
}
