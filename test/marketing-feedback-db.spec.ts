/** @file-guide
 * 목적: marketing-feedback-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §60 대표 피드백 — C53.
 *
 * 원문 §60 의 규칙은 두 줄이고, 아래는 그 두 줄이 실제로 지켜지는지 본다 —
 *   ① **「대표 코멘트는 전원 공지, 담당자 답변은 대표에게만」** — 알림이 가는 사람 수가 다르다.
 *   ② **「고쳤습니다 / 확인 필요」는 서버가 정한다** — 가장 나중 코멘트에 답이 달렸는가 하나로.
 *      시각 비교로 만들면 카드의 칩과 머리의 「고쳐야 할 것 N건」이 갈린다.
 *   ③ 답변은 **자기가 어느 코멘트에 대한 답인지** 들고 있어야 한다 (표가 거부한다).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { OpsService } from '../src/modules/ops/ops.service';
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

const CEO = 91;
const OWNER = 92;
const OTHER = 93;

d('§60 대표 피드백 (C53)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let mktId: number;

  const svc = () => new OpsService(q.manager.getRepository(Lead));
  const thread = async (viewer = CEO) =>
    (await svc().all(viewer, false, viewer === CEO)).feedback.find((t) => t.mktId === mktId)!;
  const notis = async (): Promise<Array<{ to_id: string; body: string }>> =>
    q.query(`SELECT to_id, body FROM noti ORDER BY id`) as Promise<Array<{ to_id: string; body: string }>>;

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    // 알림 대상이 「관리자 전원」이라 이 시험 안에서는 사람을 셋으로 고정한다
    await q.query(`DELETE FROM mfb`);
    await q.query(`DELETE FROM noti`);
    await q.query(`DELETE FROM staff WHERE role <> 'teacher'`);
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES
         (${CEO},'대표','mfb-ceo@t.kr','ceo'),
         (${OWNER},'담당','mfb-own@t.kr','admin'),
         (${OTHER},'다른 관리자','mfb-oth@t.kr','manager')`,
    );
    const [m] = (await q.query(
      `INSERT INTO mkt (channel, item, title, by_id) VALUES ('naver','blog','로드맵 글',${OWNER}) RETURNING id`,
    )) as Array<{ id: string }>;
    mktId = Number(m.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('대표 코멘트는 관리자 전원에게 — 쓴 본인만 뺀다 (원문 §60)', async () => {
    await svc().comment(CEO, true, mktId, { body: '제목이 길어 검색에 안 걸립니다' });
    const rows = await notis();
    expect(rows.map((r) => Number(r.to_id)).sort()).toEqual([OWNER, OTHER]);
    expect(rows[0].body).toContain('로드맵 글');
  });

  it('담당자 답변은 코멘트를 쓴 대표 한 사람에게만 (원문 §60)', async () => {
    await svc().comment(CEO, true, mktId, { body: '첫 3초에 학원명이 안 보입니다' });
    const [c] = (await thread()).posts;
    await q.query(`DELETE FROM noti`);

    await svc().reply(OWNER, mktId, { parentId: c.id, body: '로고를 앞으로 뺐습니다' });
    const rows = await notis();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].to_id)).toBe(CEO);
  });

  it('대표가 아니면 코멘트를 남길 수 없다 — 화면이 단추를 숨겨도 서버가 막는다', async () => {
    await expect(svc().comment(OWNER, false, mktId, { body: '대표인 척' }))
      .rejects.toMatchObject({ response: { code: 'CEO_ONLY' } });
    expect(await q.query(`SELECT 1 FROM mfb`)).toHaveLength(0);
  });

  it('담당자가 정해져 있으면 다른 관리자는 답하지 못한다', async () => {
    await svc().comment(CEO, true, mktId, { body: '고쳐 주세요' });
    const [c] = (await thread()).posts;
    await expect(svc().reply(OTHER, mktId, { parentId: c.id, body: '제가 답합니다' }))
      .rejects.toMatchObject({ response: { code: 'NOT_OWNER' } });
  });

  it('답이 없으면 「확인 필요」, 답이 달리면 「고쳤습니다」 — 판정은 서버 한 곳 (D-R39)', async () => {
    await svc().comment(CEO, true, mktId, { body: '첫 코멘트' });
    expect(await thread()).toMatchObject({ state: 'needs_fix', stateLabel: '확인 필요' });

    const [c] = (await thread()).posts;
    await svc().reply(OWNER, mktId, { parentId: c.id, body: '고쳤습니다' });
    expect(await thread()).toMatchObject({ state: 'fixed', stateLabel: '고쳤습니다' });
  });

  it('답 뒤에 대표가 다시 코멘트하면 **다시** 「확인 필요」 — 옛 답이 새 코멘트를 덮지 않는다', async () => {
    await svc().comment(CEO, true, mktId, { body: '첫 코멘트' });
    const [c1] = (await thread()).posts;
    await svc().reply(OWNER, mktId, { parentId: c1.id, body: '고쳤습니다' });
    expect((await thread()).state).toBe('fixed');

    await svc().comment(CEO, true, mktId, { body: '아직 안 됐습니다' });
    const t = await thread();
    expect(t.state).toBe('needs_fix');
    expect(t.posts).toHaveLength(3);
    // 카드 오른쪽 위 시각은 **가장 나중 코멘트**의 것이다 — 답의 시각이 아니다
    expect(t.at).toBe(t.posts[2].at);
  });

  it('「고쳐야 할 것 N건」을 서버가 센다 — 화면이 다시 세지 않는다 (D-R37)', async () => {
    const [m2] = (await q.query(
      `INSERT INTO mkt (channel, item, title, by_id) VALUES ('kakao','channel','릴스',${OWNER}) RETURNING id`,
    )) as Array<{ id: string }>;
    await svc().comment(CEO, true, mktId, { body: '하나' });
    await svc().comment(CEO, true, Number(m2.id), { body: '둘' });

    const before = await svc().all(CEO, false, true);
    expect(before.feedbackNeedsFix).toBe(2);
    expect(before.feedback.filter((t) => t.state === 'needs_fix')).toHaveLength(2);

    const [c] = before.feedback.find((t) => t.mktId === mktId)!.posts;
    await svc().reply(OWNER, mktId, { parentId: c.id, body: '하나 고침' });
    expect((await svc().all(CEO, false, true)).feedbackNeedsFix).toBe(1);
  });

  it('답에는 답하지 못한다 — 글타래가 두 겹이 되면 「고쳤습니다」 판정이 흐려진다', async () => {
    await svc().comment(CEO, true, mktId, { body: '코멘트' });
    const [c] = (await thread()).posts;
    await svc().reply(OWNER, mktId, { parentId: c.id, body: '답' });
    const reply = (await thread()).posts.find((p) => p.kind === 'reply')!;
    await expect(svc().reply(OWNER, mktId, { parentId: reply.id, body: '답의 답' }))
      .rejects.toMatchObject({ response: { code: 'NOT_A_COMMENT' } });
  });

  it('부모 없는 답변은 **표가** 거부한다 — 서버를 우회해도 막힌다', async () => {
    await expect(q.query(
      `INSERT INTO mfb (mkt_id, by_id, body, kind, parent_id) VALUES ($1, $2, '부모 없는 답', 'reply', NULL)`,
      [mktId, OWNER],
    )).rejects.toThrow(/mfb_reply_needs_parent/);
  });

  it('자기가 쓴 글만 고친다 — 남의 답을 고쳐 「고쳤습니다」를 만들 수 없다', async () => {
    await svc().comment(CEO, true, mktId, { body: '코멘트' });
    const [c] = (await thread()).posts;
    await svc().reply(OWNER, mktId, { parentId: c.id, body: '처음 답' });
    const reply = (await thread()).posts.find((p) => p.kind === 'reply')!;

    await expect(svc().editPost(OTHER, reply.id, { body: '남의 답 고치기' }))
      .rejects.toMatchObject({ response: { code: 'NOT_AUTHOR' } });

    await svc().editPost(OWNER, reply.id, { body: '고친 답' });
    expect((await thread()).posts.find((p) => p.kind === 'reply')!.body).toBe('고친 답');
  });

  it('title 이 없는 옛 활동도 이름이 있다 — 채널·항목으로 부른다', async () => {
    const [m] = (await q.query(
      `INSERT INTO mkt (channel, item) VALUES ('youtube','video') RETURNING id`,
    )) as Array<{ id: string }>;
    await svc().comment(CEO, true, Number(m.id), { body: '이름 없는 활동' });
    const t = (await svc().all(CEO, false, true)).feedback.find((x) => x.mktId === Number(m.id))!;
    expect(t.name).toBe('유튜브 · 영상');
    // 담당자가 없으면 이 화면을 보는 관리자가 답할 수 있다
    expect(t.canReply).toBe(true);
  });
});
