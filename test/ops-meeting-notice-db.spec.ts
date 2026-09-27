/** @file-guide
 * 목적: ops-meeting-notice-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §66 회의 — W11 운영(O) · N-32 「안내 보내기」 · 본인 참석 응답 · N-73 속기록 감사 · N-96 회의 탭 동그라미.
 *
 * 증명하는 것 —
 *   ① 안내는 **참석자(직원)에게 한 건씩** — 보내는 나 · 그만둔 사람은 빼고, 본문은 사실(이름 · 일시 · 줌 계정 · 참가 링크)만.
 *   ② 막힌 안내(취소된 회의 · 받을 사람 없음)는 읽기의 문장과 같은 409 이고 알림이 한 줄도 안 남는다.
 *   ③ 참석 응답은 **본인 줄만** — 강사 참석자도 연다 · 참석자가 아니면 없는 것(404) · 운영 권한만 있으면 403 · 대리 입력 없음.
 *   ④ 속기록 통째 덮어쓰기는 같은 트랜잭션에 감사 줄(MTREC · minutes)을 남긴다 — 앞말과 새 글.
 *   ⑤ 회의 탭 동그라미 = **이미 지난** 회의 중 속기록이 빈 수(서버가 셈) · 날이 지나도 응답은 「응답 대기」 그대로.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { makeOpsService } from './ops-svc';
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

const MGR = 961;
const MGR2 = 962;
const T1 = 963;
const GONE = 964;
const T2 = 965;
const MGR3 = 966;

d('§66 회의 안내 · 참석 응답 · 속기록 감사 · 회의 탭 동그라미 (W11 O · N-32 · N-73 · N-96)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let mtId: number;
  let serId: number;

  const svc = () => makeOpsService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    for (const t of ['todo', 'noti', 'mtattd', 'mtrec']) await q.query(`DELETE FROM ${t}`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${MGR},'운영O7','o7-mgr@t.kr','manager','매니저',true),
         (${MGR2},'매니저O7','o7-mgr2@t.kr','manager',NULL,true),
         (${T1},'강사O7','o7-t1@t.kr','teacher',NULL,true),
         (${GONE},'퇴사O7','o7-gone@t.kr','manager',NULL,false),
         (${T2},'강사둘O7','o7-t2@t.kr','teacher',NULL,true),
         (${MGR3},'매니저셋O7','o7-mgr3@t.kr','manager',NULL,true)
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('meeting','회의','#5B6470',10,'meeting',false) ON CONFLICT (key) DO NOTHING`);
    const [z] = (await q.query(
      `INSERT INTO zacc (label, login_email, login_secret, join_url, active)
       VALUES ('O7-TN','o7-zoom@t.kr','\\x00'::bytea,'https://zoom.example/j/961',true) RETURNING id`,
    )) as Array<{ id: string }>;
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date)
       VALUES ('meeting',$1,'online',1110,1170,'ONCE',$2::date) RETURNING id`,
      [MGR, day(2)],
    )) as Array<{ id: string }>;
    serId = Number(ser.id);
    await q.query(`INSERT INTO zassign (ser_id, zacc_id, fixed) VALUES ($1,$2,true)`, [serId, Number(z.id)]);
    const [m] = (await q.query(
      `INSERT INTO mtrec (mt_type, title, on_date, ser_id) VALUES ('general','주간 운영 회의',$1::date,$2) RETURNING id`,
      [day(2), serId],
    )) as Array<{ id: string }>;
    mtId = Number(m.id);
    await q.query(
      `INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${MGR},NULL),($1,${MGR2},NULL),($1,${T1},NULL),($1,${GONE},NULL)`,
      [mtId],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const notis = () => q.query(
    `SELECT to_id::int AS to_id, from_id::int AS from_id, body, link, category::text AS category, title FROM noti ORDER BY to_id`,
  ) as Promise<Array<{ to_id: number; from_id: number; body: string; link: string; category: string; title: string }>>;

  /* ── ① · ② 안내 보내기 ───────────────────────────────────────────── */

  it('안내는 참석자에게 한 건씩 — 보내는 나 · 그만둔 사람은 빠지고 본문은 사실만(줌 계정 · 참가 링크)', async () => {
    const before = (await svc().meetingDetail(mtId, { id: MGR, canManage: true }))!;
    expect(before).toMatchObject({ canEdit: true, canSendNotice: true, noticeBlockedReason: null });

    const out = await svc().sendMeetingNotice(MGR, mtId);
    expect(out.sent).toBe(2);
    const rows = await notis();
    expect(rows.map((r) => r.to_id)).toEqual([MGR2, T1]);
    for (const r of rows) {
      expect(r).toEqual({
        to_id: r.to_id, from_id: MGR,
        body: `주간 운영 회의 · ${day(2)} 18:30–19:30 · 온라인 · 줌 O7-TN · 참가 https://zoom.example/j/961`,
        // 링크는 받는 사람이 열 수 있는 자리로 — 강사는 강사 홈의 회의 창 (W11 A' 후속 P · lib/meeting-link)
        link: r.to_id === T1 ? `/teacher?meeting=${mtId}` : `/ops?tab=meeting&meeting=${mtId}`,
        category: 'schedule', title: '회의 안내',
      });
    }
    // 응답은 다시 그릴 상세 — 보낸 뒤에도 단추는 그대로 선다(다시 보낼 수 있다)
    expect(out.meeting).toMatchObject({ id: mtId, canEdit: true, canSendNotice: true });
  });

  it('이어진 회차가 없는 옛 회의는 아는 사실만 싣는다 — 자리 · 시각을 지어내지 않는다', async () => {
    await q.query(`UPDATE mtrec SET ser_id = NULL WHERE id = $1`, [mtId]);
    await svc().sendMeetingNotice(MGR, mtId);
    expect([...new Set((await notis()).map((r) => r.body))]).toEqual([`주간 운영 회의 · ${day(2)}`]);
  });

  it('취소된 회의 · 받을 사람 없는 회의는 막는다 — 읽기와 같은 문장 · 알림 0줄', async () => {
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, $2::date, $3, true,
         tstzrange(($2::date + time '18:30') AT TIME ZONE 'Asia/Seoul', ($2::date + time '19:30') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [serId, day(2), MGR],
    );
    const v = (await svc().meetingDetail(mtId, { id: MGR, canManage: true }))!;
    expect(v).toMatchObject({ canSendNotice: false, noticeBlockedReason: '취소된 회의에는 안내를 보내지 않습니다' });
    await expect(svc().sendMeetingNotice(MGR, mtId)).rejects.toMatchObject({
      response: { code: 'MEETING_NOTICE_BLOCKED', message: v.noticeBlockedReason },
    });
    expect(await notis()).toHaveLength(0);

    await q.query(`DELETE FROM ser_occ WHERE ser_id = $1`, [serId]);
    await q.query(`DELETE FROM mtattd WHERE mt_id = $1 AND staff_id <> $2`, [mtId, MGR]);
    const alone = (await svc().meetingDetail(mtId, { id: MGR, canManage: true }))!;
    expect(alone.noticeBlockedReason).toBe('안내를 받을 참석자가 없습니다');
    await expect(svc().sendMeetingNotice(MGR, mtId)).rejects.toMatchObject({
      response: { code: 'MEETING_NOTICE_BLOCKED', message: alone.noticeBlockedReason },
    });
    expect(await notis()).toHaveLength(0);
  });

  /* ── ③ 본인 참석 응답 ───────────────────────────────────────────── */

  it('강사 참석자도 상세를 연다 — 고치기 · 안내 단추는 닫히고 자기 응답 단추만 선다', async () => {
    const v = (await svc().meetingDetail(mtId, { id: T1, canManage: false }))!;
    expect(v).toMatchObject({
      canEdit: false, canSendNotice: false, noticeBlockedReason: null,
      canRespond: true, myAttend: { state: 'waiting', stateLabel: '응답 대기' },
    });
    // 운영 권한도 없고 참석자도 아니면 없는 것과 같다
    expect(await svc().meetingDetail(mtId, { id: T2, canManage: false })).toBeNull();
    // 인자 없이 부르면(서비스 직접 호출) 거르지 않되 단추는 모두 닫힌다
    expect(await svc().meetingDetail(mtId)).toMatchObject({ canEdit: false, canSendNotice: false, canRespond: false, myAttend: null });
  });

  it('참석 · 불참은 본인 줄만 바뀐다 — 대리 입력 없음 · 「참석 N/M 확인」을 서버가 다시 센다', async () => {
    const yes = await svc().respondMeeting({ id: T1, canManage: false }, mtId, true);
    expect(yes.myAttend).toEqual({ state: 'in', stateLabel: '참석' });
    expect(yes.attendLabel).toBe('참석 1/4 확인');
    const by = Object.fromEntries(yes.attendees.map((a) => [a.staffId, a.state]));
    expect(by).toEqual({ [MGR]: 'waiting', [MGR2]: 'waiting', [T1]: 'in', [GONE]: 'waiting' });

    const no = await svc().respondMeeting({ id: T1, canManage: false }, mtId, false);
    expect(no.myAttend).toEqual({ state: 'out', stateLabel: '불참' });
    expect(no.confirmed).toBe(0);
  });

  it('참석자가 아니면 응답하지 못한다 — 운영 권한이 없으면 404 · 있으면 403 · 줄은 그대로', async () => {
    await expect(svc().respondMeeting({ id: T2, canManage: false }, mtId, true))
      .rejects.toMatchObject({ response: { code: 'MEETING_NOT_FOUND' } });
    await expect(svc().respondMeeting({ id: MGR3, canManage: true }, mtId, true))
      .rejects.toMatchObject({ response: { code: 'MEETING_NOT_ATTENDEE' } });
    await expect(svc().respondMeeting({ id: MGR3, canManage: true }, 99_999_999, true))
      .rejects.toMatchObject({ response: { code: 'MEETING_NOT_FOUND' } });
    const rows = (await q.query(`SELECT count(*)::int AS n FROM mtattd WHERE mt_id = $1 AND confirmed IS NOT NULL`, [mtId])) as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });

  /* ── ④ 속기록 감사 ───────────────────────────────────────────────── */

  it('속기록을 덮어쓰면 감사 줄이 앞말과 새 글을 남긴다 — 같은 트랜잭션 · 없는 회의는 0줄', async () => {
    await svc().writeMinutes(MGR, mtId, { minutes: '처음' });
    await svc().writeMinutes(MGR2, mtId, { minutes: '  고침  ' });
    const logs = (await q.query(
      `SELECT actor_id::int AS actor, entity, action, before, after FROM log
        WHERE entity = 'MTREC' AND entity_id = $1 ORDER BY id`, [mtId],
    )) as Array<{ actor: number; entity: string; action: string; before: unknown; after: unknown }>;
    expect(logs).toEqual([
      { actor: MGR, entity: 'MTREC', action: 'minutes', before: { minutes: null }, after: { minutes: '처음' } },
      { actor: MGR2, entity: 'MTREC', action: 'minutes', before: { minutes: '처음' }, after: { minutes: '고침' } },
    ]);

    await expect(svc().writeMinutes(MGR, 99_999_999, { minutes: '유령' })).rejects.toThrow();
    const ghost = (await q.query(`SELECT count(*)::int AS n FROM log WHERE entity = 'MTREC' AND entity_id = 99999999`)) as Array<{ n: number }>;
    expect(ghost[0].n).toBe(0);
  });

  /* ── ⑤ 회의 탭 동그라미 ─────────────────────────────────────────── */

  it('회의 탭 동그라미 = 이미 지난 회의 중 속기록이 빈 수 — 오늘 · 앞날 · 날짜 없는 회의 · 쓴 회의는 세지 않는다', async () => {
    const add = async (onDate: string | null, minutes: string | null) => {
      const [r] = (await q.query(
        `INSERT INTO mtrec (mt_type, title, on_date, minutes) VALUES ('general','지난 회의',$1::date,$2) RETURNING id`,
        [onDate, minutes],
      )) as Array<{ id: string }>;
      return Number(r.id);
    };
    const past = await add(day(-3), null);
    await add(day(-2), '');
    await add(day(-1), '정한 것 둘');
    await add(todayKst(), null);
    await add(null, null);
    await q.query(`INSERT INTO mtattd (mt_id, staff_id, confirmed) VALUES ($1,${T1},NULL)`, [past]);

    const all = await svc().all(MGR, false, false);
    expect(all.mtNeedsMinutes).toBe(2);
    // 날이 지나도 응답하지 않은 줄은 「응답 대기」 그대로다 — 추정으로 불참을 적지 않는다
    const v = (await svc().meetingDetail(past, { id: T1, canManage: false }))!;
    expect(v.myAttend).toEqual({ state: 'waiting', stateLabel: '응답 대기' });
  });
});
