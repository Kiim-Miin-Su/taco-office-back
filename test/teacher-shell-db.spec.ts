/** @file-guide
 * 목적: teacher-shell-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 머리줄 — 강사 덱 모든 화면의 머리줄 「◷ Seoul · UTC+9 · ₩ 45,000원/시간 · 🔔 3」과 메뉴 사용자 칸(시간대 · 시급).
 *
 * 증명하는 것:
 *   ① 알림은 **내게 온 것만** 싣는다 — 남에게 간 알림은 같은 창 안에 있어도 0건이다(N-26 · 넓히지 않는다).
 *   ② 보이는 창은 서랍 §16 과 같은 NOTI_WINDOW_DAYS — 창 밖 옛 알림은 지우지 않고 안 싣는다.
 *   ③ 안 읽은 것이 먼저이고, 배지 수(unread)는 목록의 안 읽은 줄 수와 같다.
 *   ④ 시급은 오늘 적용되는 본인 줄(wage 의 오늘 이하 마지막 줄) · 시간대 표기는 서버가 짓는다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Ser } from '../src/entities';
import { NOTI_WINDOW_DAYS } from '../src/lib/noti';
import { TeacherService, tzLabelOf } from '../src/modules/teacher/teacher.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions,
    url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

describe('tzLabelOf — 머리줄 시간대 표기(도시 · UTC±)', () => {
  it('IANA 이름의 도시와 그 시각의 UTC 차이를 적는다', () => {
    expect(tzLabelOf('Asia/Seoul')).toBe('Seoul · UTC+9');
    expect(tzLabelOf('Asia/Kolkata')).toBe('Kolkata · UTC+5:30');
    expect(tzLabelOf('UTC')).toBe('UTC · UTC+0');
    // 서머타임은 그 시각 기준이다 — 1월 뉴욕은 UTC-5
    expect(tzLabelOf('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe('New York · UTC-5');
  });

  it('모르는 이름이면 이름만 — 화면이 깨지지 않는다', () => {
    expect(tzLabelOf('Nowhere/Land')).toBe('Nowhere/Land');
  });
});

d('강사 머리줄 — 시간대 · 시급 · 내 알림만 (GET /teacher/shell)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 83;
  const OTHER = 84;

  const svc = () => new TeacherService(q.manager.getRepository(Ser));

  beforeAll(async () => {
    ds = scratchDataSource();
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role,tz) VALUES
         ($1,'머리줄 강사','shell83@t.kr','teacher','Asia/Seoul'),
         ($2,'다른 강사','shell84@t.kr','teacher','Asia/Seoul')
       ON CONFLICT (id) DO UPDATE SET tz = EXCLUDED.tz`, [ME, OTHER],
    );
    await q.query(`DELETE FROM noti WHERE to_id IN ($1, $2)`, [ME, OTHER]);
    await q.query(`DELETE FROM wage WHERE staff_id = $1`, [ME]);
    // 오늘 이하의 마지막 줄이 지금 시급 — 앞으로 올릴 줄(내일부터)은 아직 아니다
    await q.query(
      `INSERT INTO wage (staff_id, rate, from_date) VALUES
         ($1, 42000, '2026-01-01'), ($1, 45000, (now() AT TIME ZONE 'Asia/Seoul')::date - 1),
         ($1, 99000, (now() AT TIME ZONE 'Asia/Seoul')::date + 30)`, [ME],
    );
    await q.query(
      `INSERT INTO noti (to_id, from_id, title, body, link, category, read_at, created_at) VALUES
         ($1, $2, NULL, '읽은 알림', '/schedule', 'schedule', now(), now() - interval '2 hours'),
         ($1, NULL, '리포트 반려', '9/24 MAP Reading 리포트가 반려되었습니다', '/reports', 'report', NULL, now() - interval '1 hour'),
         ($1, NULL, NULL, '창 밖 옛 알림', NULL, 'etc', NULL, now() - make_interval(days => $3::int + 5)),
         ($2, NULL, NULL, '남에게 간 알림', '/reports', 'report', NULL, now())`,
      [ME, OTHER, NOTI_WINDOW_DAYS],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('내게 온 알림만 · 창 안의 것만 · 안 읽은 것 먼저 — 배지 수는 안 읽은 줄 수', async () => {
    const out = await svc().shell(ME);
    expect(out.notis.map((n) => n.body)).toEqual(['9/24 MAP Reading 리포트가 반려되었습니다', '읽은 알림']);
    expect(out.notis.some((n) => n.body === '남에게 간 알림')).toBe(false);
    expect(out.unread).toBe(1);
    expect(out.notiWindowDays).toBe(NOTI_WINDOW_DAYS);
    expect(out.notis[0]).toMatchObject({ title: '리포트 반려', link: '/reports', read: false, categoryLabel: '리포트' });
    expect(out.notis[1]).toMatchObject({ read: true, fromName: '다른 강사', categoryLabel: '일정 변경' });
    expect(out.notis[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  });

  it('시급은 오늘 적용되는 본인 줄 · 시간대 표기는 staff.tz 에서', async () => {
    await q.query(`UPDATE staff SET tz = 'Asia/Kolkata' WHERE id = $1`, [ME]);
    const out = await svc().shell(ME);
    expect(out.wageRate).toBe(45000);
    expect(out.timezone).toBe('Asia/Kolkata');
    expect(out.tzLabel).toBe('Kolkata · UTC+5:30');
  });

  it('알림·시급이 없으면 빈 목록 · null (0 이 아니다)', async () => {
    const out = await svc().shell(OTHER + 1000);
    expect(out).toMatchObject({ notis: [], unread: 0, wageRate: null, timezone: 'Asia/Seoul' });
  });
});
