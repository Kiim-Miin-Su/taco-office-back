/** @file-guide
 * 목적: teacher-policy.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 정책 띠 (대표 결정 2026-09-25) — 안내의 숫자가 판정 상수와 같은 곳에서 나오는가.
 * 판정은 teacher.service 가 SUGGESTION_MONTHLY_LIMIT · UNAV_DEADLINE_DAYS 를, 지각 차감은 LATE_REPORT_TIERS 를 쓴다.
 */
import { LATE_REPORT_TIERS } from '../src/lib/rules';
import {
  SUGGESTION_MONTHLY_LIMIT, TEACHER_POLICY_SCREENS, UNAV_DEADLINE_DAYS, teacherPolicies,
} from '../src/lib/teacher-policy';

describe('강사 정책 띠 — 낱말 한 곳 · 숫자는 판정 상수', () => {
  const byScreen = new Map(teacherPolicies().map((p) => [p.screen, p]));

  it('띠가 서는 화면은 넷이고 전부 줄이 있다 (홈·캘린더·리포트는 지각 차감 띠가 맡는다)', () => {
    expect([...byScreen.keys()]).toEqual([...TEACHER_POLICY_SCREENS]);
    for (const p of byScreen.values()) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.lines.length).toBeGreaterThan(1);
    }
  });

  it('불가 시간 마감 일수와 건의 한도는 판정 상수 그대로다', () => {
    expect(byScreen.get('unavailable')!.lines.join(' ')).toContain(`${UNAV_DEADLINE_DAYS}일 전에 마감`);
    expect(byScreen.get('suggestions')!.lines.join(' ')).toContain(`한 달에 ${SUGGESTION_MONTHLY_LIMIT}회까지`);
  });

  it('정산 규칙의 지각 차감 문장은 판정 표(LATE_REPORT_TIERS)의 금액이다', () => {
    const history = byScreen.get('history')!.lines.join(' ');
    for (const tier of LATE_REPORT_TIERS.filter((t) => t.amount > 0)) {
      expect(history).toContain(`${tier.when} ${tier.cut}`);
    }
    expect(history).toContain('1시간 지각 시 5,000원 차감 · 4시간 이후 10,000원 차감');
  });

  it('덱보다 뒤에 확정된 결정이 이긴다 — 「승인된 리포트만」·「1주 전」 문장은 없다', () => {
    const all = teacherPolicies().flatMap((p) => p.lines).join(' ');
    expect(all).not.toContain('승인된 리포트만');
    expect(all).not.toContain('1주 전');
    expect(all).toContain('승인 여부는 보지 않습니다');
  });
});
