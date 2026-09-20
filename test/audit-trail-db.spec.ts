/** @file-guide
 * 목적: audit-trail-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * S7 「흔적을 남긴다」 — 전수 검수 §7 「흔적이 없는 쓰기」.
 *
 * 앞의 여섯 스토리는 **막거나 열거나 이어 주는** 일이었고 이것은 **되짚을 수 있게 하는** 일이다.
 * 다섯 자리 모두 쓰기 자체는 제대로 돌고 있었다 — 남지 않았을 뿐이다. 그래서 이 스위트가 보는 것은
 * 「거절되는가」가 아니라 **「지나간 자리에 줄이 남는가, 그 줄이 무엇을 말하는가」**다.
 *
 *   ① 컨설팅 항목 체크/해제 — 해제가 `done_by`·`done_at` 을 지우는데 원장에 줄이 없었다
 *   ② 교재 기본 정보 수정   — actor 를 받지도 않았다 (쪽수는 진도 퍼센트의 분모다)
 *   ③ 교재 진도 갱신        — actor 를 받지도 않았고 앞 쪽수가 덮여 사라졌다
 *   ④ GPA 기록 삭제         — 하드 삭제인데 actor 도 before 도 없었다
 *   ⑤ 대표 피드백 고치기     — 원래 무엇이라 적었는지가 사라졌다
 *
 * **두 규약을 함께 본다.**
 *   · **줄은 쓰기와 같은 트랜잭션에 있다** — 거절된 쓰기는 줄도 남기지 않는다.
 *     밖에서 남기면 쓰기는 되돌아가고 줄만 남아 「하지도 않은 일」이 장부에 찍힌다.
 *   · **원장을 고르는 규칙이 있다** — `hist` 는 원문 §40 필터 칩의 낱말이고(`HIST_ACTIONS`),
 *     칩에 없는 동작은 `log`(before/after) 나 그 도메인의 원장(`cons_event`)으로 간다.
 *     교재 수정·진도가 `hist` 를 늘리지 않는 것을 여기서 직접 센다.
 *
 * 지우는 문장을 쓰지 않는다(`DELETE FROM log` 같은 것) — 다른 스위트와 나란히 도는 스크래치 DB 라
 * 전역으로 지우면 남의 줄이 사라진다. 모든 확인은 **이 스위트가 만든 id** 로만 좁힌다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { GpaCycle, Lead } from '../src/entities';
import { BooksService } from '../src/modules/books/books.service';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import { GpaService } from '../src/modules/gpa/gpa.service';
import { HIST_ACTIONS } from '../src/lib/history';
import { makeOpsService } from './ops-svc';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

/** 이 스위트 전용 id 대역 — 다른 스위트와 나란히 돌아도 staff 를 서로 밟지 않는다 */
const ACTOR = 1791;
const OTHER = 1792;

type LogRow = { entity: string; entity_id: string; action: string; actor_id: string; before: unknown; after: unknown };
type EventRow = { event_type: string; ref_id: string | null; by_id: string };

d('S7 흔적을 남긴다 — 감사 빠진 다섯 쓰기 (전수 검수 §7)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const books = () => new BooksService(q.manager.getRepository(Lead));
  const consulting = () => new ConsultingService(q.manager.getRepository(Lead));
  const gpa = () => new GpaService(q.manager.getRepository(GpaCycle));
  const ops = () => makeOpsService(q.manager.getRepository(Lead));

  /** 그 행에 붙은 감사 줄만 본다 — 남의 줄을 세면 수가 실행 순서에 따라 흔들린다 */
  const logs = (entity: string, entityId: number): Promise<LogRow[]> =>
    q.query(`SELECT entity, entity_id, action, actor_id, before, after FROM log
              WHERE entity = $1 AND entity_id = $2 ORDER BY id`, [entity, entityId]) as Promise<LogRow[]>;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({
      ...dataSourceOptions, url,
      ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false,
      logging: false,
    });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES
         (${ACTOR},'흔적 남긴 사람','s7-actor@t.kr','admin'),
         (${OTHER},'다른 사람','s7-other@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  /* ── ① 컨설팅 항목 체크/해제 ─────────────────────────────────────── */

  // `cons_paid_stage_check` — 계약을 지난 단계(running·done)는 contract_step 이 5 로 굳는다
  const makeCons = async (stage = 'contract'): Promise<{ consId: number; itemId: number }> => {
    const [c] = (await q.query(
      `INSERT INTO cons (cons_type,stage,contract_step,share,owner_id) VALUES ('essay',$1,$2,'all',${ACTOR}) RETURNING id`,
      [stage, stage === 'contract' ? 1 : 5],
    )) as Array<{ id: string }>;
    const consId = Number(c.id);
    const [i] = (await q.query(
      `INSERT INTO cons_item (cons_id,seq,label,required) VALUES ($1,1,'추천서 초안',true) RETURNING id`, [consId],
    )) as Array<{ id: string }>;
    return { consId, itemId: Number(i.id) };
  };

  const events = (consId: number): Promise<EventRow[]> =>
    q.query(`SELECT event_type, ref_id, by_id FROM cons_event WHERE cons_id = $1 ORDER BY id`, [consId]) as Promise<EventRow[]>;

  it('① 항목을 켰다 끄면 행은 비워지지만 원장에는 두 줄이 순서대로 남는다', async () => {
    const { consId, itemId } = await makeCons();

    const on = await consulting().toggleItem(ACTOR, true, consId, itemId, { done: true });
    expect(on).toMatchObject({ done: true, doneBy: '흔적 남긴 사람' });

    const off = await consulting().toggleItem(OTHER, true, consId, itemId, { done: false });
    // **이것이 고친 이유다** — 끄면 「누가 언제」가 행에서 통째로 사라진다
    expect(off).toMatchObject({ done: false, doneBy: null, doneOn: null });
    expect(await q.query(
      `SELECT done_by, done_at FROM cons_item WHERE id = $1`, [itemId],
    )).toEqual([{ done_by: null, done_at: null }]);

    // 사라진 사실이 원장에는 남는다 — 낱말 둘이라 마지막 줄이 곧 지금 상태다
    expect(await events(consId)).toEqual([
      { event_type: 'item_done', ref_id: String(itemId), by_id: String(ACTOR) },
      { event_type: 'item_undone', ref_id: String(itemId), by_id: String(OTHER) },
    ]);
  });

  it('① 거절된 체크는 원장도 안 남긴다 — 줄과 쓰기가 같은 트랜잭션이다', async () => {
    const { consId, itemId } = await makeCons('done');
    await expect(consulting().toggleItem(ACTOR, true, consId, itemId, { done: true }))
      .rejects.toMatchObject({ response: { code: 'ITEM_LOCKED' } });
    expect(await events(consId)).toEqual([]);
    expect((await q.query(`SELECT done FROM cons_item WHERE id=$1`, [itemId]))[0].done).toBe(false);
  });

  /* ── ②③ 교재 수정 · 진도 ─────────────────────────────────────────── */

  // `lib.code` 는 varchar(30) 이고 서가에서 유일해야 한다 — 짧고 겹치지 않는 값을 만든다
  let bookSeq = 0;
  const makeBook = async (): Promise<number> => {
    bookSeq += 1;
    const code = `S7-${process.pid.toString(36)}-${Date.now().toString(36)}-${bookSeq}`;
    const [l] = (await q.query(
      `INSERT INTO lib (code,title,pages) VALUES ($1,'옛 이름',100) RETURNING id`, [code],
    )) as Array<{ id: string }>;
    return Number(l.id);
  };

  it('② 교재 수정은 **보낸 칸만** before/after 에 적고 §40 이력은 늘리지 않는다', async () => {
    const libId = await makeBook();
    const histBefore = Number((await q.query(
      `SELECT count(*)::int AS n FROM hist WHERE entity='lib' AND ref_id=$1`, [libId]))[0].n);

    await books().patchBook(ACTOR, libId, { title: '새 이름', pages: 150 });

    const rows = await logs('LIB', libId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'edit', actor_id: String(ACTOR) });
    // 안 보낸 칸(code·level·grade)은 적지 않는다 — 적으면 안 바뀐 값이 바뀐 것처럼 읽힌다
    expect(rows[0].before).toEqual({ title: '옛 이름', pages: 100 });
    expect(rows[0].after).toEqual({ title: '새 이름', pages: 150 });

    // 원문 §40 칩에 없는 동작이라 `hist` 로 가지 않는다 — 가면 「전체」에만 걸리는 줄이 된다
    expect(Number((await q.query(
      `SELECT count(*)::int AS n FROM hist WHERE entity='lib' AND ref_id=$1`, [libId]))[0].n)).toBe(histBefore);
    expect(HIST_ACTIONS).not.toContain('edit');
  });

  it('② 거절된 수정은 줄을 안 남긴다 — 진도 아래로 쪽수를 내리는 경우', async () => {
    const libId = await makeBook();
    const [s] = (await q.query(`INSERT INTO stu (name) VALUES ('교재 학생') RETURNING id`)) as Array<{ id: string }>;
    const issue = await books().createIssue(ACTOR, { libId, studentId: Number(s.id), state: 'ok', progressPage: 80 });
    expect(issue.progressPage).toBe(80);

    await expect(books().patchBook(ACTOR, libId, { pages: 50 }))
      .rejects.toMatchObject({ response: { code: 'BOOK_PAGES_BELOW_PROGRESS' } });
    expect(await logs('LIB', libId)).toEqual([]);
    expect(Number((await q.query(`SELECT pages FROM lib WHERE id=$1`, [libId]))[0].pages)).toBe(100);
  });

  it('③ 진도는 덮어쓴 앞 쪽수를 남긴다 — 그 값이 퍼센트와 쪽수 하한의 근거다', async () => {
    const libId = await makeBook();
    const [s] = (await q.query(`INSERT INTO stu (name) VALUES ('진도 학생') RETURNING id`)) as Array<{ id: string }>;
    const issue = await books().createIssue(ACTOR, { libId, studentId: Number(s.id), state: 'ok', progressPage: 20 });

    await books().updateIssueProgress(OTHER, issue.id, 55);

    const rows = await logs('ISSUE', issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'progress', actor_id: String(OTHER) });
    expect(rows[0].before).toEqual({ progressPage: 20 });
    expect(rows[0].after).toEqual({ progressPage: 55 });

    // 범위 밖은 거절되고 줄도 안 는다
    await expect(books().updateIssueProgress(OTHER, issue.id, 101)).rejects.toThrow(/100쪽/);
    expect(await logs('ISSUE', issue.id)).toHaveLength(1);
  });

  /* ── ④ GPA 기록 삭제 ─────────────────────────────────────────────── */

  const makeUse = async (): Promise<{ cycleId: number; useId: number; studentId: number }> => {
    await q.query(`INSERT INTO gpasvc (key,name,point,sort) VALUES ('s7hw','숙제 지원',1,1) ON CONFLICT (key) DO NOTHING`);
    const [cy] = (await q.query(
      `INSERT INTO gpa_cycle (no, from_date, to_date) VALUES (77, '2026-10-05', '2026-11-01') RETURNING id`,
    )) as Array<{ id: string }>;
    const cycleId = Number(cy.id);
    const [s] = (await q.query(`INSERT INTO stu (name) VALUES ('GPA 학생') RETURNING id`)) as Array<{ id: string }>;
    const studentId = Number(s.id);
    const made = await gpa().createUse(ACTOR, { cycleId, studentId, svcKey: 's7hw', onDate: '2026-10-07' });
    return { cycleId, useId: made.id, studentId };
  };

  it('④ 지운 기록은 통째로 before 에 남는다 — 하드 삭제라 여기 말고는 되짚을 데가 없다', async () => {
    const { cycleId, useId, studentId } = await makeUse();

    expect(await gpa().deleteUse(useId, OTHER)).toEqual({ ok: true });
    expect(await q.query(`SELECT 1 FROM gpa_use WHERE id=$1`, [useId])).toHaveLength(0);

    const rows = await logs('GPA_USE', useId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'delete', actor_id: String(OTHER), after: null });
    expect(rows[0].before).toMatchObject({
      cycleId, studentId, svcKey: 's7hw', points: 1, onDate: '2026-10-07', state: 'wait', coordId: ACTOR,
    });
  });

  it('④ 승인분 삭제 거절은 줄을 안 남긴다 — 판정을 잠금 안에서 다시 본다', async () => {
    const { useId } = await makeUse();
    await gpa().setUseState(useId, OTHER, { state: 'ok' });

    await expect(gpa().deleteUse(useId, OTHER)).rejects.toMatchObject({ response: { code: 'USE_APPROVED' } });
    expect(await q.query(`SELECT 1 FROM gpa_use WHERE id=$1`, [useId])).toHaveLength(1);
    // 승인 줄(approve)은 있고 삭제 줄은 없다
    expect((await logs('GPA_USE', useId)).map((r) => r.action)).toEqual(['approve']);
  });

  /* ── ⑤ 대표 피드백 고치기 ───────────────────────────────────────── */

  const makePost = async (byId: number): Promise<number> => {
    const [m] = (await q.query(
      `INSERT INTO mkt (channel, item, title, by_id) VALUES ('naver','blog','S7 글',${ACTOR}) RETURNING id`,
    )) as Array<{ id: string }>;
    const [p] = (await q.query(
      `INSERT INTO mfb (mkt_id, by_id, body, kind) VALUES ($1,$2,'처음 적은 말','comment') RETURNING id`,
      [Number(m.id), byId],
    )) as Array<{ id: string }>;
    return Number(p.id);
  };

  it('⑤ 글을 고치면 앞말이 남는다 — 지금의 참은 고친 글이고 앞말은 원장에 있다', async () => {
    const postId = await makePost(ACTOR);

    await ops().editPost(ACTOR, postId, { body: '고쳐 적은 말' });

    expect((await q.query(`SELECT body FROM mfb WHERE id=$1`, [postId]))[0].body).toBe('고쳐 적은 말');
    const rows = await logs('MFB', postId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'edit', actor_id: String(ACTOR) });
    expect(rows[0].before).toEqual({ body: '처음 적은 말' });
    expect(rows[0].after).toEqual({ body: '고쳐 적은 말' });
  });

  it('⑤ 남의 글 고치기 거절은 줄도 글도 안 건드린다', async () => {
    const postId = await makePost(OTHER);

    await expect(ops().editPost(ACTOR, postId, { body: '남의 글을 고친다' }))
      .rejects.toMatchObject({ response: { code: 'NOT_AUTHOR' } });
    expect((await q.query(`SELECT body FROM mfb WHERE id=$1`, [postId]))[0].body).toBe('처음 적은 말');
    expect(await logs('MFB', postId)).toEqual([]);
  });
});
