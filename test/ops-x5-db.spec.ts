/** @file-guide
 * 목적: ops-x5-db.spec.ts — 운영 잔여 물결(wave 5) — 마케팅 활동 등록 · 필터 건수 · 피드백 차례 · 보완 요청 · 회의 짧은 이름 (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 운영 §59·§60·§61·§63·§65 — 잔여 물결(wave 5 · x5).
 *
 * 증명하는 것 —
 *   ① §59 「+ 오늘 한 것」 — 활동 한 줄이 **목록과 같은 모양**으로 돌아오고(낱말은 서버), 날짜 기본은 오늘 ·
 *      담당 기본은 나 · 감사 줄 한 줄. 빈 제목 · 그만둔 담당은 막힌다. (g6 59-3 · P1)
 *   ② §59 필터 띠 「어디에 · 누가」와 머리의 항목 범례 · 「N건 N일 진행」을 **서버가 센다** — 고른 기간 안에서만. (59-4 · 59-5)
 *   ③ §60 카드 차례는 **최근 코멘트가 위** — 상태로 먼저 가르지 않는다(원문 컷 21:15 → 21:10). (60-1)
 *   ④ §65 「보완 요청」은 기한 승인과 무관하다 — 원문 규칙이 막는 것은 **최종 승인**뿐이다. (65-7)
 *   ⑤ §63 종류 칩 줄과 줄 머리 칩은 **짧은 이름**(「기획」)이다 — §66 머리의 긴 이름은 그대로. (63-7)
 *   ⑥ §61 기한 상태 칩 낱말 「기한 승인」 (61-3)
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead, Ser } from '../src/entities';
import { makeOpsService } from './ops-svc';
import { TeacherService } from '../src/modules/teacher/teacher.service';
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

const CEO = 5591;
const MGR = 5592;
const GONE = 5593;
const TEACHER = 5594;

d('운영 잔여 물결 (x5)', () => {
  let ds: DataSource;
  let q: QueryRunner;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['mfb', 'todo', 'noti', 'mtattd', 'mtrec', 'suggestion']) await q.query(`DELETE FROM ${t}`);
    await q.query(`DELETE FROM mkt`);
    await q.query(`DELETE FROM log WHERE entity IN ('plan','MKT','SUGGESTION')`);
    await q.query(`DELETE FROM plan`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${CEO},'대표x5','x5-ceo@t.kr','ceo','대표',true),
         (${MGR},'매니저x5','x5-mgr@t.kr','manager','매니저',true),
         (${GONE},'퇴사x5','x5-gone@t.kr','manager',NULL,false),
         (${TEACHER},'강사x5','x5-teacher@t.kr','teacher','강사',true)
       ON CONFLICT (id) DO NOTHING`,
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const mkt = async (channel: string, item: string, onDate: string | null, byId: number | null, title = '활동'): Promise<number> => {
    const [r] = (await q.query(
      `INSERT INTO mkt (channel, item, on_date, by_id, title) VALUES ($1,$2,$3::date,$4,$5) RETURNING id`,
      [channel, item, onDate, byId, title],
    )) as Array<{ id: string }>;
    return Number(r.id);
  };

  /* ── ① §59 「+ 오늘 한 것」 ─────────────────────────────────────────── */

  it('활동 한 줄은 목록과 같은 모양 — 낱말은 서버 · 날짜 기본 오늘 · 담당 기본 나 · 감사 줄 (59-3)', async () => {
    const row = await svc().createMarketing(MGR, true, {
      title: '  학습실 하루 · 30초 릴스  ', channel: 'instagram', item: 'video',
      url: 'https://instagram.com/p/abc', memo: '  조회 1.2천  ',
    });
    expect(row).toMatchObject({
      title: '학습실 하루 · 30초 릴스', name: '학습실 하루 · 30초 릴스',
      channel: 'instagram', channelLabel: '인스타그램', item: 'video', itemLabel: '릴스·영상',
      byId: MGR, byName: '매니저x5', url: 'https://instagram.com/p/abc', onDate: todayKst(),
      // W11 · N-29 ② — 카드 제목 아래 메모 한 줄(앞뒤 공백만 걷는다)
      memo: '조회 1.2천',
    });
    // 목록(`GET /ops`)이 같은 줄을 같은 모양으로 준다 — 쓰기 응답이 다른 모양이면 화면이 두 벌을 들고 간다
    const all = await svc().all(CEO, true, true);
    expect(all.marketing.find((m) => m.id === row.id)).toEqual(row);
    const logs = (await q.query(`SELECT actor_id, action FROM log WHERE entity = 'MKT' AND entity_id = $1`, [row.id])) as Array<{ actor_id: string; action: string }>;
    expect(logs).toEqual([{ actor_id: String(MGR), action: 'create' }]);
    const [after] = (await q.query(`SELECT after FROM log WHERE entity = 'MKT' AND entity_id = $1`, [row.id])) as Array<{ after: Record<string, unknown> }>;
    expect(after.after).toMatchObject({ memo: '조회 1.2천' });
  });

  it('담당과 날짜를 고르면 그대로 · 빈 URL · 빈 메모는 비움 (59-3 · N-29 ②)', async () => {
    const row = await svc().createMarketing(CEO, true, {
      title: '검색광고 · 대치 국제학교 키워드', channel: 'naver_ad', item: 'ad', url: '   ', onDate: day(-2), byId: MGR, memo: '   ',
    });
    expect(row).toMatchObject({ byId: MGR, onDate: day(-2), url: null, channelLabel: '네이버 광고', itemLabel: '광고 집행', memo: null });
  });

  it('새로 적을 때는 원문 넷 · 넷만 고른다 — 옛 코드(`naver` · `flyer` …)는 읽히기만 한다 (W11 · N-29 ①)', async () => {
    await expect(svc().createMarketing(CEO, true, { title: '옛 채널', channel: 'naver', item: 'post' }))
      .rejects.toMatchObject({ response: { code: 'MKT_WORD_UNKNOWN' } });
    await expect(svc().createMarketing(CEO, true, { title: '옛 항목', channel: 'naver_blog', item: 'blog' }))
      .rejects.toMatchObject({ response: { code: 'MKT_WORD_UNKNOWN' } });
    // 표가 마지막으로 막는다 — 원문 넷과 옛 코드 밖의 낱말은 CHECK 가 거절한다
    await q.query(`SAVEPOINT words`);
    await expect(q.query(`INSERT INTO mkt (channel, item) VALUES ('tiktok','post')`)).rejects.toThrow(/mkt_channel_words/);
    await q.query(`ROLLBACK TO SAVEPOINT words`);
    await expect(q.query(`INSERT INTO mkt (channel, item) VALUES ('kakao','reels')`)).rejects.toThrow(/mkt_item_words/);
  });

  it('빈 제목 · 그만둔 담당 · 없는 담당은 막힌다 — 한 줄도 안 남는다 (59-3)', async () => {
    await expect(svc().createMarketing(CEO, true, { title: '   ', channel: 'naver_ad', item: 'ad' }))
      .rejects.toMatchObject({ response: { code: 'MKT_TITLE_REQUIRED' } });
    await expect(svc().createMarketing(CEO, true, { title: '문의 응대', channel: 'kakao', item: 'reply', byId: GONE }))
      .rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    await expect(svc().createMarketing(CEO, true, { title: '문의 응대', channel: 'kakao', item: 'reply', byId: 9_999_999 }))
      .rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    const [n] = (await q.query(`SELECT count(*)::int AS n FROM mkt`)) as Array<{ n: number }>;
    expect(n.n).toBe(0);
  });

  it('마케팅 활동은 보낸 칸만 고친다 — 담당 검증·앞뒤 감사·목록 재조회가 함께 맞는다', async () => {
    const made = await svc().createMarketing(CEO, true, {
      title: '수정 전', channel: 'kakao', item: 'reply', onDate: day(-2), byId: CEO, memo: '전 메모',
    });
    const changed = await svc().patchMarketing(MGR, true, made.id, {
      title: '  수정 후  ', channel: 'naver_blog', item: 'post', byId: MGR, memo: null,
    });
    expect(changed).toMatchObject({
      title: '수정 후', name: '수정 후', channel: 'naver_blog', channelLabel: '네이버 블로그',
      item: 'post', itemLabel: '글 발행', byId: MGR, byName: '매니저x5', memo: null, onDate: day(-2),
    });
    expect((await svc().all(CEO, true, true)).marketing.find((m) => m.id === made.id)).toEqual(changed);
    const [log] = await q.query(`SELECT before, after FROM log WHERE entity='MKT' AND entity_id=$1 AND action='edit'`, [made.id]);
    expect(log).toMatchObject({ before: { title: '수정 전', byId: CEO, memo: '전 메모' }, after: { title: '수정 후', byId: MGR, memo: null } });
    await expect(svc().patchMarketing(CEO, true, made.id, { byId: GONE }))
      .rejects.toMatchObject({ response: { code: 'STAFF_NOT_FOUND' } });
    expect((await q.query(`SELECT by_id FROM mkt WHERE id=$1`, [made.id]))[0].by_id).toBe(String(MGR));
  });

  it('관리자 건의 답변은 done·답변자·시각·알림·감사로 남고 강사 재조회에 보인다', async () => {
    const [made] = await q.query(
      `INSERT INTO suggestion (staff_id, category, body) VALUES ($1,'schedule','목요일 수업을 앞당기고 싶습니다') RETURNING id`,
      [TEACHER],
    );
    const id = Number(made.id);
    const answered = await svc().replySuggestion(CEO, id, { reply: '  담당자와 확인 후 목요일 4시로 옮겼습니다.  ' });
    expect(answered).toMatchObject({
      id, staffName: '강사x5', state: 'done', reply: '담당자와 확인 후 목요일 4시로 옮겼습니다.', replyBy: '대표x5',
    });
    expect(answered.replyOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const teacher = new TeacherService(q.manager.getRepository(Ser));
    expect((await teacher.suggestions(TEACHER)).items[0]).toMatchObject({
      id, state: 'done', reply: answered.reply, replyBy: '대표x5', replyOn: answered.replyOn,
    });
    expect((await q.query(`SELECT title, link FROM noti WHERE to_id=$1 ORDER BY id DESC LIMIT 1`, [TEACHER]))[0])
      .toEqual({ title: '건의 답변', link: '/teacher/suggestions' });
    expect((await q.query(`SELECT before, after FROM log WHERE entity='SUGGESTION' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [id]))[0])
      .toMatchObject({ before: { reply: null, replyBy: null }, after: { replyBy: CEO, replyAt: expect.any(String), state: 'done' } });
  });

  /* ── ② §59 필터 띠 · 범례 ─────────────────────────────────────────── */

  it('「어디에 · 누가」 · 항목 범례 · 「N건 N일 진행」은 고른 기간 안에서 서버가 센다 (59-4 · 59-5) · 채널 × 항목은 따로 움직인다 (N-29 ①)', async () => {
    // 원문 컷 한 주의 넷 — 같은 「네이버」가 광고와 블로그로 갈린다
    await mkt('kakao', 'reply', day(-3), MGR);
    await mkt('naver_ad', 'ad', day(-2), CEO);
    await mkt('instagram', 'video', day(-1), MGR);
    await mkt('naver_blog', 'post', day(-1), MGR);
    await mkt('naver', 'ad', day(-2), MGR);        // 옛 코드의 옛 행 — 옛 이름 그대로(이관 없음)
    await mkt('youtube', 'video', day(-30), null); // 기간 밖

    const all = await svc().all(CEO, true, true, { from: day(-6), to: day(0) });
    expect(all.marketing).toHaveLength(5);
    // 건수가 있는 것만 선다 — 원문 §59 띠에 0 건 채널은 없다. 많은 순 · 같으면 이름 순
    expect(all.mktChannelCounts).toEqual([
      { key: 'naver', label: '네이버', count: 1 },
      { key: 'naver_ad', label: '네이버 광고', count: 1 },
      { key: 'naver_blog', label: '네이버 블로그', count: 1 },
      { key: 'instagram', label: '인스타그램', count: 1 },
      { key: 'kakao', label: '카카오채널', count: 1 },
    ]);
    expect(all.mktByCounts).toEqual([
      { key: String(MGR), label: '매니저x5', count: 4 },
      { key: String(CEO), label: '대표x5', count: 1 },
    ]);
    expect(all.mktItemCounts).toEqual([
      { key: 'ad', label: '광고 집행', count: 2 },
      { key: 'post', label: '글 발행', count: 1 },
      { key: 'reply', label: '댓글·응대', count: 1 },
      { key: 'video', label: '릴스·영상', count: 1 },
    ]);
    // 「3일 진행」 — 활동이 있었던 날 수
    expect(all.mktDays).toBe(3);
    // 폼의 낱말 — 원문 컷의 넷 · 넷(나머지 셋 · 셋은 짓지 않는다) · 차례도 컷 그대로 (D-R18 · N-29 ①)
    expect(all.mktChannels).toEqual([
      { key: 'kakao', label: '카카오채널' }, { key: 'naver_ad', label: '네이버 광고' },
      { key: 'instagram', label: '인스타그램' }, { key: 'naver_blog', label: '네이버 블로그' },
    ]);
    expect(all.mktItems).toEqual([
      { key: 'reply', label: '댓글·응대' }, { key: 'ad', label: '광고 집행' },
      { key: 'video', label: '릴스·영상' }, { key: 'post', label: '글 발행' },
    ]);
    expect(all.canCreateMarketing).toBe(true);
  });

  /* ── ③ §60 카드 차례 ──────────────────────────────────────────────── */

  it('§60 카드는 최근 코멘트가 위 — 「고쳤습니다」가 나중이면 위에 선다 (60-1)', async () => {
    const reels = await mkt('instagram', 'video', day(-1), MGR, '학습실 하루 · 30초 릴스');
    const road = await mkt('naver', 'blog', day(-1), MGR, '강남 국제학교 준비 로드맵 · 8월');
    // 21:10 — 릴스에 코멘트(답 없음 · 확인 필요)
    await q.query(`INSERT INTO mfb (mkt_id, by_id, body, kind, at) VALUES ($1,$2,'로고를 앞으로','comment', now() - interval '10 minutes')`, [reels, CEO]);
    // 21:15 — 로드맵에 코멘트, 그리고 답(고쳤습니다)
    const [c] = (await q.query(
      `INSERT INTO mfb (mkt_id, by_id, body, kind, at) VALUES ($1,$2,'키워드를 앞에','comment', now() - interval '5 minutes') RETURNING id`,
      [road, CEO],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO mfb (mkt_id, by_id, body, kind, parent_id, at) VALUES ($1,$2,'바꿨습니다','reply',$3, now())`, [road, MGR, c.id]);

    const { feedback, feedbackNeedsFix } = await svc().all(CEO, true, true);
    expect(feedback.map((t) => [t.mktId, t.state])).toEqual([[road, 'fixed'], [reels, 'needs_fix']]);
    expect(feedbackNeedsFix).toBe(1);
  });

  /* ── ④ §65 보완 요청 ─────────────────────────────────────────────── */

  it('「보완 요청」은 기한 승인 전에도 열린다 — 막히는 것은 최종 승인뿐 (65-7)', async () => {
    const [p] = (await q.query(
      `INSERT INTO plan (title, stage, due_on, owner_id) VALUES ('기한 제안만 있는 기획','review',$1::date,$2) RETURNING id`,
      [day(3), MGR],
    )) as Array<{ id: string }>;
    const id = Number(p.id);
    const before = await svc().planDetail(id, true, CEO);
    expect(before).toMatchObject({ dueState: 'proposed', canReview: false, reviewBlockedReason: '기한부터 승인하세요', canRework: true, reworkBlockedReason: null });

    // 최종 승인은 여전히 막힌다 — 같은 문장
    await expect(svc().reviewPlan(CEO, true, id, { decision: 'approve' }))
      .rejects.toMatchObject({ response: { code: 'DUE_NOT_APPROVED', message: '기한부터 승인하세요' } });
    // 보완 요청은 된다 — 사유는 여전히 필수
    await expect(svc().reviewPlan(CEO, true, id, { decision: 'rework', reason: '  ' }))
      .rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });
    const after = await svc().reviewPlan(CEO, true, id, { decision: 'rework', reason: '예산 근거를 더해 주세요' });
    expect(after).toMatchObject({ stage: 'rework', reworkReason: '예산 근거를 더해 주세요', canRework: false });
  });

  it('보완 요청도 권한·자기 결재·단계 규칙은 그대로 — 막힌 이유는 읽기와 쓰기가 같은 말 (65-7)', async () => {
    const [p] = (await q.query(
      `INSERT INTO plan (title, stage, due_on, owner_id) VALUES ('초안','draft',$1::date,$2) RETURNING id`,
      [day(3), MGR],
    )) as Array<{ id: string }>;
    const id = Number(p.id);
    const draft = await svc().planDetail(id, true, CEO);
    expect(draft).toMatchObject({ canRework: false, reworkBlockedReason: '아직 검토 요청이 올라오지 않았습니다' });
    await expect(svc().reviewPlan(CEO, true, id, { decision: 'rework', reason: '다시' }))
      .rejects.toMatchObject({ response: { message: '아직 검토 요청이 올라오지 않았습니다' } });
    const notCeo = await svc().planDetail(id, false, MGR);
    expect(notCeo).toMatchObject({ canRework: false, reworkBlockedReason: '기획 결재는 대표만 합니다' });
  });

  /* ── ⑤ §63 짧은 이름 · ⑥ §61 기한 낱말 ────────────────────────────── */

  it('§63 종류 칩 줄과 줄 머리 칩은 짧은 이름 — 긴 이름은 그대로 둔다 (63-7)', async () => {
    await q.query(`INSERT INTO mtrec (mt_type, title, on_date) VALUES ('plan','주간 기획',$1::date)`, [day(1)]);
    const all = await svc().all(CEO, true, true);
    expect(all.mtTypeCounts.map((c) => c.label)).toEqual(['기획', '컨설팅', '마케팅', '개발', '일반']);
    expect(all.meetings[0]).toMatchObject({ mtType: 'plan', mtTypeLabel: '기획 회의', mtTypeShort: '기획' });
    // 「+ 회의 잡기」 폼의 낱말은 긴 이름 그대로 — 두 자리가 다른 낱말을 쓰는 것이 원문이다
    expect(all.mtTypes.map((t) => t.label)[0]).toBe('기획 회의');
  });

  it('§61 기한 상태 칩 낱말은 원문 그대로 「기한 승인」 (61-3)', async () => {
    await q.query(
      `INSERT INTO plan (title, stage, due_on, owner_id, due_approved_at, due_approved_by) VALUES ('승인된 기획','approved',$1::date,$2, now(), $3)`,
      [day(3), MGR, CEO],
    );
    const all = await svc().all(CEO, true, true);
    expect(all.plans[0]).toMatchObject({ dueState: 'approved', dueStateLabel: '기한 승인' });
  });
});
