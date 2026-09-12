/** @file-guide
 * 목적: meeting-detail-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §66 회의 상세 — C57.
 *
 * 증명하는 것 넷 —
 *   ① **참석은 세 값이다.** `null`(응답 대기) 을 `false`(불참) 로 접지 않는다.
 *   ② **「참석 N/M 확인」을 서버가 만든다** (D-R37).
 *   ③ **속기록은 누가 언제 저장했는지 남는다.** 화면이 보낸 시각을 믿지 않는다.
 *   ④ **할 일과 알림이 한 트랜잭션이다** — 막힌 배정은 알림도 남기지 않는다 (D-R43).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { OpsService } from '../src/modules/ops/ops.service';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({
    ...dataSourceOptions, url,
    ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

const ME = 51;
const A = 52;
const B = 53;
const C = 54;

d('§66 회의 상세 (C57)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let mtId: number;

  const svc = () => new OpsService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM todo`);
    await q.query(`DELETE FROM noti`);
    await q.query(`DELETE FROM mtattd`);
    await q.query(`DELETE FROM mtrec`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title) VALUES
         (${ME},'나','mt-me@t.kr','admin','관리자'),
         (${A},'가','mt-a@t.kr','manager','매니저'),
         (${B},'나나','mt-b@t.kr','manager',NULL),
         (${C},'다','mt-c@t.kr','teacher',NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    const [m] = (await q.query(
      `INSERT INTO mtrec (mt_type, title, on_date, pre_files)
       VALUES ('general','주간 운영 회의',$1,'["seed://pre/agenda.pdf"]'::jsonb) RETURNING id`,
      [day(-1)],
    )) as Array<{ id: string }>;
    mtId = Number(m.id);
    await q.query(
      `INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${ME},NULL),($1,${A},true),($1,${B},false),($1,${C},NULL)`,
      [mtId],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('참석은 세 값이다 — 「응답 대기」와 「불참」을 같은 칩으로 접지 않는다', async () => {
    const v = (await svc().meetingDetail(mtId))!;
    const by = Object.fromEntries(v.attendees.map((a) => [a.staffId, a]));
    expect(by[ME].stateLabel).toBe('응답 대기');
    expect(by[A].stateLabel).toBe('참석');
    expect(by[B].stateLabel).toBe('불참');
    expect(by[C].stateLabel).toBe('응답 대기');
  });

  it('「참석 N/M 확인」을 서버가 만든다 — 불참은 확인 수에 안 들어간다 (D-R37)', async () => {
    const v = (await svc().meetingDetail(mtId))!;
    expect(v.confirmed).toBe(1);
    expect(v.attendLabel).toBe('참석 1/4 확인');
  });

  it('회의 종류 이름도 서버가 만든다 — 코드값이 화면으로 새지 않는다 (D-R18)', async () => {
    const v = (await svc().meetingDetail(mtId))!;
    expect(v.mtType).toBe('general');
    expect(v.mtTypeLabel).toBe('일반 회의');
    // §63 목록도 같은 낱말을 쓴다
    const { meetings } = await svc().all(ME, false, false);
    expect(meetings.find((m) => m.id === mtId)!.mtTypeLabel).toBe('일반 회의');
  });

  it('속기록을 처음 저장하면 누가 언제인지가 남는다', async () => {
    const before = (await svc().meetingDetail(mtId))!;
    expect(before.minutes).toBeNull();
    expect(before.minutesAt).toBeNull();
    expect(before.minutesByName).toBeNull();

    const after = await svc().writeMinutes(ME, mtId, { minutes: '[정한 것]\n· 9월 블로그 8편' });
    expect(after.minutes).toContain('정한 것');
    expect(after.minutesByName).toBe('나');
    expect(after.minutesAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  });

  it('다시 저장하면 마지막 사람으로 바뀐다 — 처음 적은 사람으로 굳지 않는다', async () => {
    await svc().writeMinutes(ME, mtId, { minutes: '처음' });
    const after = await svc().writeMinutes(A, mtId, { minutes: '고침' });
    expect(after.minutes).toBe('고침');
    expect(after.minutesByName).toBe('가');
  });

  it('속기록 머리말 넷과 안내 한 줄을 서버가 내려보낸다 — 회의마다 제각각이 되지 않게', async () => {
    const v = (await svc().meetingDetail(mtId))!;
    expect(v.minutesTemplates).toEqual(['[정한 것]', '[누가 무엇을]', '[다음 회의까지]', '[보류]']);
    expect(v.minutesHint).toBe('정한 것 · 누가 무엇을 · 다음 회의까지');
  });

  it('배정한 할 일은 TODO 가 되고 담당자에게 알림이 간다 (원문 §66 연동)', async () => {
    const v = await svc().assignMeetingTask(ME, mtId, { title: '단가 시뮬레이션', toId: A, dueOn: day(3) });
    expect(v.tasks).toHaveLength(1);
    expect(v.tasks[0]).toMatchObject({ title: '단가 시뮬레이션', toName: '가', done: false, overdueDays: 0 });

    const [t] = await q.query(`SELECT src, mt_id, from_id FROM todo WHERE title = '단가 시뮬레이션'`);
    expect({ src: t.src, mtId: Number(t.mt_id), from: Number(t.from_id) }).toEqual({ src: 'meeting', mtId, from: ME });

    const notis = await q.query(`SELECT to_id, body FROM noti`);
    expect(notis).toHaveLength(1);
    expect(Number(notis[0].to_id)).toBe(A);
    expect(notis[0].body).toContain('주간 운영 회의');
  });

  it('자기에게 배정하면 알림을 보내지 않는다 — 자기가 방금 적은 것이다', async () => {
    await svc().assignMeetingTask(ME, mtId, { title: '내가 할 것', toId: ME });
    expect(await q.query(`SELECT 1 FROM noti`)).toHaveLength(0);
    expect(await q.query(`SELECT 1 FROM todo`)).toHaveLength(1);
  });

  it('없는 담당자에게는 배정하지 않는다 — 알림도 안 남는다 (D-R43)', async () => {
    await expect(svc().assignMeetingTask(ME, mtId, { title: '유령에게', toId: 999_999 }))
      .rejects.toThrow();
    expect(await q.query(`SELECT 1 FROM todo`)).toHaveLength(0);
    expect(await q.query(`SELECT 1 FROM noti`)).toHaveLength(0);
  });

  it('지난 기한과 끝낸 할 일을 서버가 구분한다', async () => {
    await svc().assignMeetingTask(ME, mtId, { title: '늦은 것', toId: A, dueOn: day(-3) });
    await svc().assignMeetingTask(ME, mtId, { title: '끝낸 것', toId: A, dueOn: day(-5) });
    await q.query(`UPDATE todo SET done = true WHERE title = '끝낸 것'`);

    const v = (await svc().meetingDetail(mtId))!;
    expect(v.taskDone).toBe(1);
    expect(v.tasks.find((t) => t.title === '늦은 것')!.overdueDays).toBe(3);
    // 끝낸 일은 늦었든 아니든 0 이다 (lib/kst 의 계약)
    expect(v.tasks.find((t) => t.title === '끝낸 것')!.overdueDays).toBe(0);
  });

  it('사전 자료는 있는 것만 싣는다', async () => {
    expect((await svc().meetingDetail(mtId))!.preFiles).toEqual(['seed://pre/agenda.pdf']);
    await q.query(`UPDATE mtrec SET pre_files = NULL WHERE id = $1`, [mtId]);
    expect((await svc().meetingDetail(mtId))!.preFiles).toEqual([]);
  });

  it('표가 반쪽 기록을 거부한다 — 저장 시각만 있고 누가 했는지 없을 수 없다', async () => {
    await expect(q.query(`UPDATE mtrec SET minutes_at = now() WHERE id = $1`, [mtId]))
      .rejects.toThrow(/mtrec_minutes_author_pair/);
  });

  it('없는 회의면 null 을 돌려준다 — 컨트롤러가 404 로 옮긴다', async () => {
    expect(await svc().meetingDetail(99_999_999)).toBeNull();
  });
});
