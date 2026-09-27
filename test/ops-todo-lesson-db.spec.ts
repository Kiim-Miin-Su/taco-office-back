/** @file-guide
 * 목적: ops-todo-lesson-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 수업 상세 「+ 할 일」 → §64 연결 수업 칩 — W11 운영(O) · N-71.
 *
 * 증명하는 것 —
 *   ① `POST /drawer/todos` 가 회차 키 두 칸(serId · onDate)을 받으면 출처가 수업(src=lesson)인 할 일이 된다.
 *   ② 회차 검증 — 두 칸은 함께만(400) · 수업에 거는 것은 일정 권한(403) · 없는 회차(404) · 휴강한 회차(409) · 막히면 0줄.
 *   ③ §64 줄의 연결 수업 칩은 서버 투영 — 이름(제목 → 과목 → 종류) · 그려지는 회차의 시작 · 그 회차를 여는 시간표 주소.
 *      옮긴 회차는 **그려지는 날**로 연다(회차 키는 규칙이 찍은 날 그대로).
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
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

const MGR = 941;
const T = 942;

d('수업 상세 「+ 할 일」 · §64 연결 수업 칩 (W11 O · N-71)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let serId: number;

  const drawer = () => new DrawerService(q.manager.getRepository(Lead));
  const ops = () => makeOpsService(q.manager.getRepository(Lead));

  /** 회차 하나 — `onDate` 는 규칙이 찍은 날(키), `drawn` 은 그려지는 날(옮기면 다르다) */
  const occ = async (onDate: string, drawn: string, canceled = false) => {
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, canceled, span)
       VALUES ($1, $2::date, $3, $4,
         tstzrange(($5::date + time '09:30') AT TIME ZONE 'Asia/Seoul', ($5::date + time '10:30') AT TIME ZONE 'Asia/Seoul', '[)'))`,
      [serId, onDate, T, canceled, drawn],
    );
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`DELETE FROM todo`);
    await q.query(
      `INSERT INTO staff (id,name,email,role,title,active) VALUES
         (${MGR},'운영O7t','o7t-mgr@t.kr','manager','매니저',true),
         (${T},'강사O7t','o7t-t@t.kr','teacher',NULL,true)
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ('o7class','수업O7','#123456',4,'lesson',false) ON CONFLICT (key) DO NOTHING`);
    const [ser] = (await q.query(
      `INSERT INTO ser (kind_key, teacher_id, mode, start_min, end_min, rrule, from_date, title)
       VALUES ('o7class',$1,'offline',570,630,'ONCE',$2::date,'학습실') RETURNING id`,
      [T, day(1)],
    )) as Array<{ id: string }>;
    serId = Number(ser.id);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('회차 키를 실으면 출처가 수업인 할 일이 되고 §64 줄이 연결 수업 칩을 단다', async () => {
    await occ(day(1), day(1));
    const { id } = await drawer().createTodo(MGR, true, { title: '교재 확인', toId: T, dueOn: day(1), serId, onDate: day(1) });
    const [row] = (await q.query(
      `SELECT src::text AS src, ser_id::int AS ser_id, to_char(on_date,'YYYY-MM-DD') AS on_date FROM todo WHERE id = $1`, [id],
    )) as Array<Record<string, unknown>>;
    expect(row).toEqual({ src: 'lesson', ser_id: serId, on_date: day(1) });

    const todo = (await ops().all(MGR, false, false)).todos.find((t) => t.id === id)!;
    expect(todo.src).toBe('lesson');
    expect(todo.lesson).toEqual({
      label: '학습실 09:30', color: '#123456',
      go: `/schedule?date=${day(1)}&serId=${serId}&onDate=${day(1)}`,
    });
    // 손으로 만든 할 일은 칩이 없다
    const manual = await drawer().createTodo(MGR, true, { title: '그냥 할 일' });
    expect((await ops().all(MGR, false, false)).todos.find((t) => t.id === manual.id)!.lesson).toBeNull();
  });

  it('옮긴 회차는 그려지는 날로 연다 — 회차 키(규칙이 찍은 날)는 그대로', async () => {
    await occ(day(3), day(4));
    const { id } = await drawer().createTodo(MGR, true, { title: '옮긴 수업 준비', serId, onDate: day(3) });
    const todo = (await ops().all(MGR, false, false)).todos.find((t) => t.id === id)!;
    expect(todo.lesson?.go).toBe(`/schedule?date=${day(4)}&serId=${serId}&onDate=${day(3)}`);
  });

  /**
   * W11 A' 후속 2 — §64 줄의 「원본」 링크. **서랍 §15 와 운영 §64 가 같은 함수(lib/todo `todoGo`) 한 곳**으로 짓고,
   * 대상 화면이 한 건을 여는 질의를 이미 읽는 것만 만든다. 두 투영이 같은 줄에 같은 주소를 준다는 것을 같은 표본으로 본다.
   */
  it('「원본」 링크 — 출처마다 그 한 건을 여는 주소 · 서랍과 운영이 같은 값 · 손으로 만든 할 일과 투영에 없는 회차는 없음', async () => {
    await occ(day(3), day(4));
    const [lead] = (await q.query(`INSERT INTO lead (name, stage) VALUES ('상담O7g','enrolled') RETURNING id`)) as Array<{ id: string }>;
    const leadId = Number(lead.id);
    const put = async (title: string, src: string, col: string, value: number, extra = ''): Promise<number> => {
      const [row] = (await q.query(
        `INSERT INTO todo (title, from_id, to_id, src, ${col}${extra ? ', care' : ''}) VALUES ($1, ${MGR}, ${MGR}, $2, $3${extra ? `, '${extra}'` : ''}) RETURNING id`,
        [title, src, value],
      )) as Array<{ id: string }>;
      return Number(row.id);
    };
    const ids = {
      meeting: await put('회의에서 나온 일', 'meeting', 'mt_id', 9711),
      complaint: await put('컴플레인 조치', 'complaint', 'cpl_id', 9712),
      consulting: await put('컨설팅 준비', 'consulting', 'cons_id', 9713),
      plan: await put('기획 과제', 'plan', 'plan_id', 9714),
      lead: await put('해피콜', 'lead', 'lead_id', leadId, 'happycall'),
      lesson: (await drawer().createTodo(MGR, true, { title: '옮긴 수업 준비', serId, onDate: day(3) })).id,
      gone: (await drawer().createTodo(MGR, true, { title: '투영에 없는 회차', serId, onDate: day(3) })).id,
      manual: (await drawer().createTodo(MGR, true, { title: '손으로 만든 일' })).id,
    };
    // 투영에서 회차가 사라지면(규칙 삭제 · 기간 밖) 그려지는 날을 모른다 — 두 번째 수업 할 일은 다른 회차 키로 옮겨 둔다
    await q.query(`UPDATE todo SET on_date = $2::date WHERE id = $1`, [ids.gone, day(20)]);
    const expected: Record<keyof typeof ids, string | null> = {
      meeting: '/ops?tab=meeting&meeting=9711',
      complaint: '/ops?tab=complaint&cpl=9712',
      consulting: '/consulting?id=9713',
      plan: '/ops?tab=plan&plan=9714',
      lead: `/intake?lead=${leadId}`,
      // 수업은 §64 연결 수업 칩과 같은 주소 — 그려지는 날(day+4)로 연다
      lesson: `/schedule?date=${day(4)}&serId=${serId}&onDate=${day(3)}`,
      gone: null,
      manual: null,
    };
    const opsTodos = (await ops().all(MGR, false, false)).todos;
    const drawerTodos = (await drawer().all(MGR, true, true)).todos;
    for (const [key, id] of Object.entries(ids) as Array<[keyof typeof ids, number]>) {
      expect({ key, go: opsTodos.find((t) => t.id === id)?.go }).toEqual({ key, go: expected[key] });
      expect({ key, go: drawerTodos.find((t) => t.id === id)?.go ?? null }).toEqual({ key, go: expected[key] });
    }
    // 연결 수업 칩의 이동도 같은 주소다(한 함수 · 두 자리)
    expect(opsTodos.find((t) => t.id === ids.lesson)?.lesson?.go).toBe(expected.lesson);
  });

  it('회차 검증 — 두 칸 함께 · 일정 권한 · 있는 회차 · 휴강 아님 — 막히면 한 줄도 안 생긴다', async () => {
    await occ(day(1), day(1));
    await occ(day(2), day(2), true);
    await expect(drawer().createTodo(MGR, true, { title: '반쪽', serId }))
      .rejects.toMatchObject({ response: { code: 'TODO_LESSON_KEY' } });
    await expect(drawer().createTodo(T, false, { title: '강사가 건다', serId, onDate: day(1) }))
      .rejects.toMatchObject({ response: { code: 'TODO_LESSON_FORBIDDEN' } });
    await expect(drawer().createTodo(MGR, true, { title: '없는 회차', serId, onDate: day(9) }))
      .rejects.toMatchObject({ response: { code: 'LESSON_NOT_FOUND' } });
    await expect(drawer().createTodo(MGR, true, { title: '휴강 회차', serId, onDate: day(2) }))
      .rejects.toMatchObject({ response: { code: 'TODO_LESSON_CANCELED' } });
    const [n] = (await q.query(`SELECT count(*)::int AS n FROM todo`)) as Array<{ n: number }>;
    expect(n.n).toBe(0);
  });
});
