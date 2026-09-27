/** @file-guide
 * 목적: holiday-2027-db.spec.ts — 2027 공휴일 · 2026 개정 두 날 데이터 migration (N-82 · W11)
 * 책임/재사용: migration 목록의 모양(요일 · 대체 규칙)과 DB 에 실제로 들어간 줄을 본다. 공휴일 판정 규칙을 새로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource } from 'typeorm';
import { DEV_URL } from './db';
import { Holiday20271764000000000 as M } from '../src/migrations/1764000000000-holiday-2027';

/** 월=0 … 일=6 — 날짜 문자열을 UTC 자정으로 읽어 요일만 본다(시간대와 무관) */
const weekday = (d: string): number => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;

describe('2027 공휴일 목록 (N-82 · 우주항공청 2027년 월력요항)', () => {
  it('일요일 외 24줄 · 일요일과 겹친 넷을 빼면 월력요항의 72(= 52 + 24 − 4)와 맞는다', () => {
    expect(M.Y2027).toHaveLength(24);
    const sundays = M.Y2027.filter(([d]) => weekday(d) === 6).map(([d, n]) => `${d} ${n}`);
    expect(sundays).toEqual(['2027-02-07 설날', '2027-06-06 현충일', '2027-08-15 광복절', '2027-10-03 개천절']);
    expect(52 + M.Y2027.length - sundays.length).toBe(72);
  });

  it('대체공휴일은 모두 월요일이거나 설 연휴 다음 날(화)이고 원래 날 뒤에 온다', () => {
    const subs = M.Y2027.filter(([, n]) => n.endsWith(' 대체'));
    expect(subs.map(([d, n]) => `${d} ${n}`)).toEqual([
      '2027-02-09 설날 대체', '2027-05-03 노동절 대체', '2027-07-19 제헌절 대체', '2027-08-16 광복절 대체',
      '2027-10-04 개천절 대체', '2027-10-11 한글날 대체', '2027-12-27 성탄절 대체',
    ]);
    for (const [d, n] of subs) {
      const base = n.replace(/ 대체$/, '');
      const orig = M.Y2027.find(([, nn]) => nn === base);
      expect(orig && orig[0] < d).toBe(true);
      expect([0, 1]).toContain(weekday(d));
    }
  });

  it('2026 개정 두 날은 금요일이라 대체가 없다 · 이름은 40자 안 · 키가 겹치지 않는다', () => {
    expect(M.Y2026_ADDED.map(([d, n]) => `${d} ${n} ${weekday(d)}`)).toEqual(['2026-05-01 노동절 4', '2026-07-17 제헌절 4']);
    const keys = [...M.Y2026_ADDED, ...M.Y2027].map(([d, n]) => `${d}|${n}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [, n] of [...M.Y2026_ADDED, ...M.Y2027]) expect(n.length).toBeLessThanOrEqual(40);
  });
});

const d = DEV_URL ? describe : describe.skip;

d('2027 공휴일 — DB 에 들어간 줄 (읽기만)', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: DEV_URL });
    await ds.initialize();
  });
  afterAll(async () => { await ds?.destroy(); });

  it('holiday 표에 2027 24줄과 2026 개정 두 날이 있다', async () => {
    const rows = (await ds.query(
      `SELECT to_char(on_date, 'YYYY-MM-DD') AS d, name FROM holiday
        WHERE on_date BETWEEN '2027-01-01' AND '2027-12-31' ORDER BY on_date, name`,
    )) as Array<{ d: string; name: string }>;
    expect(rows.map((r) => [r.d, r.name])).toEqual(M.Y2027.map(([dd, n]) => [dd, n]));
    const added = (await ds.query(
      `SELECT to_char(on_date, 'YYYY-MM-DD') AS d, name FROM holiday WHERE (on_date, name) IN (('2026-05-01','노동절'), ('2026-07-17','제헌절')) ORDER BY on_date`,
    )) as Array<{ d: string; name: string }>;
    expect(added).toEqual([{ d: '2026-05-01', name: '노동절' }, { d: '2026-07-17', name: '제헌절' }]);
  });
});
