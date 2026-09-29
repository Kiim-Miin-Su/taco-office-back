/** @file-guide
 * 목적: noti.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 알림 색 — `lib/noti.ts`.
 *
 * NOTI 표에 색 컬럼이 없어 **링크로 파생**한다. 표에 컬럼이 생기는 날
 * 이 파일이 바뀔 곳을 한 군데로 못 박아 둔다.
 */
import { notiTone, NOTI_TITLE, NOTI_TONES } from '../src/lib/noti';

describe('notiTone', () => {
  it('막힌 일은 warn', () => {
    expect(notiTone('/reports/unwritten')).toBe('warn');
    expect(notiTone('/reports?section=unwritten')).toBe('warn');
    expect(notiTone('/ops?tab=complaint&cpl=3')).toBe('warn');
  });
  it('front 에 없는 옛 주소는 색을 받지 않는다 — 지금 「끝난 소식」만 가리키는 주소는 없다 (deep-link-contract)', () => {
    expect(notiTone('/accounting/paid')).toBe('alarm');
    expect(notiTone('/ops/complaints')).toBe('alarm');
  });
  it('그 밖에는 alarm — 색이 없어 안 보이는 일은 없다', () => {
    expect(notiTone('/ops?tab=mkt')).toBe('alarm');
    expect(notiTone(null)).toBe('alarm');
    expect(notiTone('')).toBe('alarm');
    expect(notiTone(undefined)).toBe('alarm');
  });
  it('세 가지 밖으로 나가지 않는다', () => {
    ['/x', '/reports/unwritten', '/accounting/paid', null].forEach((l) =>
      expect(NOTI_TONES).toContain(notiTone(l)));
  });
});

describe('NOTI_TITLE — §16 카드 제목 낱말 (16-1 · impl3-w8)', () => {
  it('제목은 짧은 한국어 한 줄 — DB 칸(varchar 80)에 들고 내부 코드·영문 코드값이 없다', () => {
    const titles = Object.values(NOTI_TITLE);
    expect(titles.length).toBeGreaterThan(20);
    for (const t of titles) {
      expect(t.length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(20);
      expect(t).not.toMatch(/[A-Za-z§#]|\bD-R|N-\d/);
    }
    // 같은 낱말이 두 열쇠에 있으면 한쪽이 다른 일을 가리키는 것이다
    expect(new Set(titles).size).toBe(titles.length);
  });
});
