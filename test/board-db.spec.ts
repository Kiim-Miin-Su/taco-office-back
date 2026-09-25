/** @file-guide
 * 목적: board-db.spec.ts — §34~§36 현황판의 안내 마크 대상 · 기간 facet · 날짜 집계 · 줌 계정 이름을 실제 Postgres에서 검증한다 (test)
 * 책임/재사용: BoardService 공개 메서드와 GuidesService 초안 경로를 그대로 부른다. 판정 규칙을 테스트에 다시 쓰지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * g4 §34-5 · §34-3 · §34-10 · §35-3 · §36-3.
 *
 * - **안내 마크**는 원문 규칙 줄 「안내는 첫 수업이거나 강사가 바뀐 학생만 '필요'」대로 대상이 아니면 해당 없음이다.
 *   전에는 언제나 대상이라, 안내가 필요 없는 수업이 「안내」 완료(초록)로 섰다.
 * - **facet**은 거르기 전의 그 기간에 나온 과목·강사만 준다 — 칩 줄이 21과목·전 직원을 늘어놓지 않게.
 * - **days[]** 는 §35 요일 머리 · §36 달력 칸의 수다 (화면이 rows 를 다시 세지 않는다).
 * 격리 DB 트랜잭션 안에서 돌고 끝나면 되돌린다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { BoardService } from '../src/modules/board/board.service';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

/** 2031-03 화요일 셋 — 시드·다른 스위트와 겹치지 않는 날 */
const D1 = '2031-03-04';
const D2 = '2031-03-11';
const D3 = '2031-03-18';
const OUTSIDE = '2031-05-06';

d('§34~§36 현황판 — 안내 대상 · 기간 facet · 날짜 집계 (g4 34-5 · 34-3 · 35-3 · 36-3)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const teacherA = 2451;
  const teacherB = 2452;
  const teacherC = 2453;
  const serX = -2451;
  const serY = -2452;
  const serZ = -2453;
  const kindKey = 'w4-board';
  const subA = 'w4-sub-a';
  const subB = 'w4-sub-b';
  const subC = 'w4-sub-c';
  const zaccId = -2451;
  let s1 = 0;
  let s2 = 0;
  const svc = () => new BoardService(q.manager.getRepository(Lead));

  const occ = (serId: number, on: string, teacherId: number, startHour: number, zacc: number | null = null) =>
    q.query(
      `INSERT INTO ser_occ (ser_id,on_date,teacher_id,zacc_id,span)
       VALUES ($1,$2::date,$3,$4, tstzrange(($2::date + make_interval(hours => $5)) AT TIME ZONE 'Asia/Seoul',
                                            ($2::date + make_interval(hours => $5 + 1)) AT TIME ZONE 'Asia/Seoul','[)'))`,
      [serId, on, teacherId, zacc, startHour],
    );
  const guideMark = async (serId: number, on: string) => {
    const board = await svc().range({ from: on, to: on });
    const row = board.rows.find((item) => item.serId === serId);
    return row?.marks.find((mark) => mark.key === 'guide');
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES
      ($1,'가강사','w4-board-a@test','teacher'),($2,'나강사','w4-board-b@test','teacher'),($3,'다강사','w4-board-c@test','teacher')
      ON CONFLICT (id) DO NOTHING`, [teacherA, teacherB, teacherC]);
    await q.query(`INSERT INTO kind (key,name,color,cap,grp,rep) VALUES ($1,'W4 수업','#123456',8,'lesson',true)
      ON CONFLICT (key) DO NOTHING`, [kindKey]);
    await q.query(`INSERT INTO sub (key,name,color,sort) VALUES
      ($1,'W4 Reading','#2266aa',2),($2,'W4 Math','#aa6622',1),($3,'W4 Writing','#22aa66',3)
      ON CONFLICT (key) DO NOTHING`, [subA, subB, subC]);
    await q.query(`INSERT INTO zacc (id,label,login_email,login_secret,join_url,meeting_id,meeting_pw_enc,active)
      VALUES ($1,'Study','w4-board-zoom@test','\\x00','https://zoom.example/j/2451','245-100','\\x2a',true)
      ON CONFLICT (id) DO NOTHING`, [zaccId]);
    const made = await q.query(`INSERT INTO stu (name,grade) VALUES ('현황 하나','G9'),('현황 둘','G8') RETURNING id`);
    [s1, s2] = made.map((r: { id: string }) => Number(r.id));

    // X — 오프라인 · 과목 A · 강사 A → A → B (셋째 회차는 강사 교체)
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'offline',600,660,'FREQ=WEEKLY;BYDAY=TU',$5,$6)`, [serX, kindKey, subA, teacherA, D1, D3]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serX, s1]);
    await occ(serX, D1, teacherA, 10);
    await occ(serX, D2, teacherA, 10);
    await occ(serX, D3, teacherB, 10);
    // Y — 온라인 · 과목 B · 강사 B · 줌 계정 Study · D1 09시(과목 순서를 보려고 X 보다 먼저)
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'online',540,600,'FREQ=WEEKLY;BYDAY=TU',$5,$5)`, [serY, kindKey, subB, teacherB, D1]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serY, s2]);
    await occ(serY, D1, teacherB, 9, zaccId);
    // Z — 기간 밖(5월) · 과목 C · 강사 C — facet 에 서면 안 된다
    await q.query(`INSERT INTO ser (id,kind_key,sub_key,teacher_id,mode,start_min,end_min,rrule,from_date,to_date)
      VALUES ($1,$2,$3,$4,'offline',600,660,'FREQ=WEEKLY;BYDAY=TU',$5,$5)`, [serZ, kindKey, subC, teacherC, OUTSIDE]);
    await q.query(`INSERT INTO ser_stu (ser_id,student_id) VALUES ($1,$2)`, [serZ, s1]);
    await occ(serZ, OUTSIDE, teacherC, 10);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('34-5 안내 마크 — 첫 수업·강사 교체 학생이 없는 회차는 해당 없음, 있으면 대상이고 안내가 없으면 덜 됐다', async () => {
    // 둘째 회차: 같은 강사의 두 번째 수업 — 안내 대상이 아니다 (전에는 언제나 대상이라 「완료」로 섰다)
    expect(await guideMark(serX, D2)).toMatchObject({ na: true, done: false });
    // 첫 회차(첫 수업) · 셋째 회차(강사 교체) — 안내가 아직 없다
    expect(await guideMark(serX, D1)).toMatchObject({ na: false, done: false });
    expect(await guideMark(serX, D3)).toMatchObject({ na: false, done: false });
  });

  it('34-5 안내 마크 — 보낸 안내(sent·read)만 됐다고 친다 · 초안은 아직이다 · 강사 교체 안내는 첫 수업을 덮는다', async () => {
    await q.query(`INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on)
      VALUES ($1,$2,$3,'new','sent',$4::date,$4::date)`, [serX, s1, teacherA, D1]);
    await q.query(`INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on)
      VALUES ($1,$2,$3,'teacher_change','draft',$4::date,$4::date)`, [serX, s1, teacherB, D3]);
    expect(await guideMark(serX, D1)).toMatchObject({ na: false, done: true });
    expect(await guideMark(serX, D3)).toMatchObject({ na: false, done: false });
    await q.query(`UPDATE guide SET state='read' WHERE ser_id=$1 AND event_on=$2::date`, [serX, D3]);
    expect(await guideMark(serX, D3)).toMatchObject({ na: false, done: true });

    // Y 의 첫 수업은 강사 교체 안내 하나로 덮인다 (§45 누락 판정과 같은 조건)
    expect(await guideMark(serY, D1)).toMatchObject({ na: false, done: false });
    await q.query(`INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on)
      VALUES ($1,$2,$3,'teacher_change','sent',$4::date,$4::date)`, [serY, s2, teacherB, D1]);
    expect(await guideMark(serY, D1)).toMatchObject({ na: false, done: true });
  });

  it('34-3 facet — 거르기 전의 그 기간에 나온 과목·강사만, 과목은 코드표 순서 · 강사는 이름 순 · 기간 밖은 없다', async () => {
    const board = await svc().range({ from: D1, to: D3, subKey: subA });
    // 줄은 과목 A 만 (거른 결과)
    expect(board.rows.every((row) => row.subKey === subA)).toBe(true);
    // facet 은 거르기 전 — B 도 선다. 기간 밖 C 는 없다
    expect(board.facets.subjects).toEqual([
      { key: subB, name: 'W4 Math', lessons: 1 },
      { key: subA, name: 'W4 Reading', lessons: 3 },
    ]);
    expect(board.facets.teachers).toEqual([
      { id: teacherB, name: '나강사', lessons: 2 },
      { id: teacherA, name: '가강사', lessons: 2 },
    ].sort((a, b) => a.name.localeCompare(b.name, 'ko')));
  });

  it('34-3 facet — 강사 본인 범위(scope)면 facet 도 본인 수업에서만 나온다', async () => {
    const board = await svc().range({ from: D1, to: D3, teacherId: teacherA, scopeTeacherId: teacherA });
    expect(board.facets.teachers).toEqual([{ id: teacherA, name: '가강사', lessons: 2 }]);
    expect(board.facets.subjects.map((s) => s.key)).toEqual([subA]);
  });

  it('35-3 · 36-3 days[] — 날짜마다 수업 수 · 남은 수 · 과목 키(시각 순) · 34-10 온라인 수업의 줌 계정 이름', async () => {
    const board = await svc().range({ from: D1, to: D3 });
    const first = board.days.find((day) => day.date === D1);
    expect(first).toMatchObject({ lessons: 2, canceled: 0, subKeys: [subB, subA] });
    // 남은 수 = 그날 missing > 0 인 수업 수 (rows 에서 그대로)
    expect(first?.remaining).toBe(board.rows.filter((row) => row.date === D1 && !row.canceled && row.missing > 0).length);
    expect(board.days.map((day) => day.date)).toEqual([D1, D2, D3]);
    const online = board.rows.find((row) => row.serId === serY);
    expect(online).toMatchObject({ mode: 'online', zaccLabel: 'Study' });
    expect(board.rows.find((row) => row.serId === serX)?.zaccLabel ?? null).toBeNull();
  });
});
