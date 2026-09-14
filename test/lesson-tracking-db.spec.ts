/** @file-guide
 * 목적: lesson-tracking-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §79 수강 학생 — 학생 트래킹 (C55).
 *
 * 증명하는 것 넷 —
 *   ① **정원·자리 수를 서버가 센다.** 그날만 빠진 학생은 인원에서 빼되 목록에는 남는다 (D-R21).
 *   ② **금액은 대표만.** 못 보는 사람에게는 단가·총액·미수가 전부 null 이다 (D-R39).
 *   ③ **「정시 / 지연」은 `tierFor` 한 곳이 정한다** — 강사 화면의 차감액과 같은 판정이다 (D-R32).
 *   ④ **30일 출결은 확정된 것만 센다.** 아직 확정 안 한 회차는 분모에도 없다.
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { SerOcc } from '../src/entities';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
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

/** 오늘에서 n 일 */
const day = (n: number): string => {
  const t = new Date(`${todayKst()}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

d('§79 학생 트래킹 (C55)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let serId: number;
  let stuA: number;
  let stuB: number;

  const svc = () => new ScheduleService(q.manager.getRepository(SerOcc));
  const onDate = day(-1);

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();

    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (71,'트래킹 강사','trk@t.kr','teacher')
       ON CONFLICT (id) DO NOTHING`,
    );
    // 정원은 원문 슬라이드 88 의 값이다 (C54). 시험이 스스로 그 값을 세워 두고 확인한다
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep,rep_form,sort)
       VALUES ('class','수업','#4A5461',4,'lesson',true,'dev',1)
       ON CONFLICT (key) DO UPDATE SET cap = 4, rep = true`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('sat-math','SAT Math','#9C7A38')
       ON CONFLICT (key) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO rate (kind_key, sub_key, heads, unit_price, from_date)
       VALUES ('class','sat-math',1,120000,$1),('class','sat-math',2,80000,$1)
       ON CONFLICT DO NOTHING`,
      [day(-90)],
    );
    const [a] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('가학생','고1') RETURNING id`)) as Array<{ id: string }>;
    const [b] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('나학생','고2') RETURNING id`)) as Array<{ id: string }>;
    stuA = Number(a.id); stuB = Number(b.id);

    // kind 는 시드의 것을 그대로 쓴다 — 정원도 시드(원문) 값이어야 회귀가 의미 있다
    const [s] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, teacher_id, rrule, from_date, mode, start_min, end_min)
       VALUES ('class','sat-math',71,'FREQ=WEEKLY;BYDAY=MO',$1,'offline',600,660) RETURNING id`,
      [day(-60)],
    )) as Array<{ id: string }>;
    serId = Number(s.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2),($1,$3)`, [serId, stuA, stuB]);
    // 상세는 목록에 실제로 존재하는 물리 회차에서만 연다. 반복 parser와 독립적으로
    // 이 테스트가 검증하는 회차 키를 명시해 임의 onDate 허용 회귀를 막는다.
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, span)
       VALUES ($1,$2::date,71,tstzrange($2::date + time '10:00' - interval '9 hours',
                                      $2::date + time '11:00' - interval '9 hours'))`,
      [serId, onDate],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('정원과 자리 수를 서버가 센다 — 화면이 cap − count 를 다시 하지 않는다 (D-R37)', async () => {
    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.cap).toBe(4);          // 원문 슬라이드 88 의 `class` 정원 (C54)
    expect(t.count).toBe(2);
    expect(t.canAdd).toBe(2);
    expect(t.capLabel).toBe('정원 4명 · 2명 더 넣을 수 있습니다');
  });

  it('그날만 빠진 학생은 인원에서 빠지되 목록에는 남는다 (D-R21)', async () => {
    const [e] = (await q.query(
      `INSERT INTO exc (ser_id, on_date) VALUES ($1,$2) RETURNING id`, [serId, onDate],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1,$2)`, [Number(e.id), stuA]);

    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.count).toBe(1);
    expect(t.canAdd).toBe(3);
    expect(t.students).toHaveLength(2);
    expect(t.students.find((s) => s.id === stuA)!.droppedOnce).toBe(true);
  });

  it('그날만 빠진 학생의 개인 시간표 조회에서는 해당 회차를 제외한다 (D-R21)', async () => {
    const [e] = (await q.query(
      `INSERT INTO exc (ser_id, on_date) VALUES ($1,$2) RETURNING id`, [serId, onDate],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1,$2)`, [Number(e.id), stuA]);

    expect(await svc().list({ from: onDate, to: onDate, studentId: stuA })).toHaveLength(0);
    expect(await svc().list({ from: onDate, to: onDate, studentId: stuB })).toHaveLength(1);
  });

  it('금액은 대표만 — 못 보면 단가 · 총액 · 미수가 전부 null 이다 (D-R39)', async () => {
    await q.query(
      `INSERT INTO inv (student_id, year_month, title, amount, paid_amount, state, inv_type)
       VALUES ($1,'2026-08','8월 수업료',500000,200000,'unpaid','tuition')`, [stuA],
    );
    const open = (await svc().tracking(serId, onDate, true))!;
    expect(open.students.find((s) => s.id === stuA)!.unpaid).toBe(300000);
    // 가격은 명단 쓰기 응답과 **같은 함수**에서 나온다 (lib/rules.rosterPricing · §54)
    expect({ priced: open.priced, unitPrice: open.unitPrice, total: open.total })
      .toEqual({ priced: true, unitPrice: 80000, total: 160000 });

    const shut = (await svc().tracking(serId, onDate, false))!;
    expect(shut.canSeeAmounts).toBe(false);
    expect(shut.unitPrice).toBeNull();
    expect(shut.total).toBeNull();
    for (const s of shut.students) expect(s.unpaid).toBeNull();
  });

  it('교재 수는 ISSUE.state=ok만 센다 — 승인·전달 대기는 배부 완료가 아니다', async () => {
    const [lib] = await q.query(
      `INSERT INTO lib (code,title,sub_key) VALUES ($1,'대기 교재','sat-math') RETURNING id`,
      [`TRACK-WAIT-${stuA}`],
    ) as Array<{ id: string }>;
    const [issue] = await q.query(
      `INSERT INTO issue (lib_id,student_id,state,requested_by) VALUES ($1,$2,'wait',71) RETURNING id`,
      [Number(lib.id), stuA],
    ) as Array<{ id: string }>;
    expect((await svc().tracking(serId, onDate, true))!.students.find((s) => s.id === stuA)!.bookCount).toBe(0);

    await q.query(
      `UPDATE issue SET state='ok',issued_on=$2::date,approved_by=71,delivered_at=now() WHERE id=$1`,
      [Number(issue.id), onDate],
    );
    expect((await svc().tracking(serId, onDate, true))!.students.find((s) => s.id === stuA)!.bookCount).toBe(1);
  });

  it('진도 평균은 배부 완료 중 쪽수를 아는 교재를 책별 동일가중하고 미확인·회수는 제외한다', async () => {
    const [knownA] = await q.query(
      `INSERT INTO lib (code,title,sub_key,pages) VALUES ($1,'진도 교재','sat-math',200) RETURNING id`,
      [`TRACK-PROGRESS-A-${stuA}`],
    ) as Array<{ id: string }>;
    const [knownB] = await q.query(
      `INSERT INTO lib (code,title,sub_key,pages) VALUES ($1,'두번째 진도 교재','sat-math',100) RETURNING id`,
      [`TRACK-PROGRESS-B-${stuA}`],
    ) as Array<{ id: string }>;
    const [unknown] = await q.query(
      `INSERT INTO lib (code,title,sub_key) VALUES ($1,'쪽수 미정','sat-math') RETURNING id`,
      [`TRACK-UNKNOWN-${stuA}`],
    ) as Array<{ id: string }>;
    const [returned] = await q.query(
      `INSERT INTO lib (code,title,sub_key,pages) VALUES ($1,'회수 교재','sat-math',100) RETURNING id`,
      [`TRACK-RETURNED-${stuA}`],
    ) as Array<{ id: string }>;
    await q.query(
      `INSERT INTO issue (lib_id,student_id,state,requested_by,issued_on,approved_by,delivered_at,progress_page)
       VALUES ($1,$5,'ok',71,$6,71,now(),50),
              ($2,$5,'ok',71,$6,71,now(),75),
              ($3,$5,'ok',71,$6,71,now(),20),
              ($4,$5,'ok',71,$6,71,now(),100)`,
      [Number(knownA.id), Number(knownB.id), Number(unknown.id), Number(returned.id), stuA, onDate],
    );
    await q.query(`UPDATE issue SET state='returned',returned_on=$2 WHERE lib_id=$1`, [Number(returned.id), onDate]);

    const student = (await svc().tracking(serId, onDate, true))!.students.find((s) => s.id === stuA)!;
    expect({ average: student.progressAverage, knownBooks: student.progressKnownBooks })
      .toEqual({ average: 50, knownBooks: 2 });
  });

  it('취소된 청구서는 미수가 아니다 — 상태 목록을 여기서 다시 적지 않는다', async () => {
    await q.query(
      `INSERT INTO inv (student_id, year_month, title, amount, paid_amount, state, inv_type)
       VALUES ($1,'2026-08','취소된 것',900000,0,'void','tuition')`, [stuA],
    );
    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.students.find((s) => s.id === stuA)!.unpaid).toBe(0);
  });

  it('30일 출결은 확정된 것만 센다 — 확정 안 한 회차는 분모에도 없다', async () => {
    const before = (await svc().tracking(serId, onDate, true))!;
    expect(before.students[0].attendTotal).toBe(0);

    await q.query(
      `INSERT INTO att (ser_id, on_date, result, confirmed_by) VALUES ($1,$2,'completed',71),($1,$3,'canceled',71)`,
      [serId, day(-7), day(-14)],
    );
    // 30일 밖은 세지 않는다
    await q.query(
      `INSERT INTO att (ser_id, on_date, result, confirmed_by) VALUES ($1,$2,'completed',71)`,
      [serId, day(-40)],
    );

    const t = (await svc().tracking(serId, onDate, true))!;
    const s = t.students.find((x) => x.id === stuA)!;
    expect({ done: s.attendDone, total: s.attendTotal }).toEqual({ done: 1, total: 2 });
  });

  it('그날 빠진 회차는 그 학생의 출결에서 빠진다 — 다른 학생 것은 그대로다', async () => {
    await q.query(
      `INSERT INTO att (ser_id, on_date, result, confirmed_by) VALUES ($1,$2,'completed',71)`,
      [serId, day(-7)],
    );
    const [e] = (await q.query(
      `INSERT INTO exc (ser_id, on_date) VALUES ($1,$2) RETURNING id`, [serId, day(-7)],
    )) as Array<{ id: string }>;
    await q.query(`INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1,$2)`, [Number(e.id), stuA]);

    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.students.find((s) => s.id === stuA)!.attendTotal).toBe(0);
    expect(t.students.find((s) => s.id === stuB)!.attendTotal).toBe(1);
  });

  it('「정시 / 지연」은 수업 종료 시각과 제출 시각으로 정한다 — 낱말도 서버가 만든다', async () => {
    const mk = async (onD: string, submitMinutesAfterEnd: number) => {
      await q.query(
        `INSERT INTO ser_occ (ser_id, on_date, span, teacher_id)
         VALUES ($1, $2::date, tstzrange($2::date + time '10:00' - interval '9 hours',
                                         $2::date + time '11:00' - interval '9 hours'), 71)`,
        [serId, onD],
      );
      const [r] = (await q.query(
        `INSERT INTO rep (ser_id, on_date, teacher_id, kind_key, body, state, written_at, submitted_at)
         VALUES ($1, $2::date, 71, 'class',
                 '{"content":"한 것","progress":"진도","homework":"숙제"}'::jsonb, 'wait',
                 $2::date + time '11:00' - interval '9 hours',
                 $2::date + time '11:00' - interval '9 hours' + ($3 || ' minutes')::interval)
         RETURNING id`,
        [serId, onD, String(submitMinutesAfterEnd)],
      )) as Array<{ id: string }>;
      await q.query(`INSERT INTO rep_stu (rep_id, student_id) VALUES ($1,$2)`, [Number(r.id), stuA]);
    };
    await mk(day(-7), 10);    // 1시간 이내 — 차감 없음
    await mk(day(-14), 300);  // 4시간 초과 — 차감

    const t = (await svc().tracking(serId, onDate, true))!;
    const rs = t.students.find((s) => s.id === stuA)!.reports;
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.onTimeLabel)).toEqual(['정시', '지연']);
    // 최신이 먼저 — 원문 카드가 위에서부터 최근 순이다
    expect(rs[0].onDate > rs[1].onDate).toBe(true);
  });

  it('안 쓴 리포트는 싣지 않는다 — 「최신 3건」은 쓴 것 중에서 센다', async () => {
    await q.query(
      `INSERT INTO rep (ser_id, on_date, teacher_id, kind_key, body, state)
       VALUES ($1, $2::date, 71, 'class', '{}'::jsonb, 'draft')`,
      [serId, day(-3)],
    );
    const [r] = (await q.query(`SELECT id FROM rep WHERE ser_id=$1 ORDER BY id DESC LIMIT 1`, [serId])) as Array<{ id: string }>;
    await q.query(`INSERT INTO rep_stu (rep_id, student_id) VALUES ($1,$2)`, [Number(r.id), stuA]);

    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.students.find((s) => s.id === stuA)!.reports).toHaveLength(0);
  });

  it('없는 수업이면 null 을 돌려준다 — 컨트롤러가 404 로 옮긴다', async () => {
    expect(await svc().tracking(99_999_999, onDate, true)).toBeNull();
  });

  it('SER가 있어도 실제 회차가 아닌 날짜이면 null을 돌려준다', async () => {
    expect(await svc().tracking(serId, day(1), true)).toBeNull();
  });
});

/**
 * §12 준비 줄 — 원본 두 컷이 정한 목록 (C82-b).
 *
 * 온라인 §12 는 아홉 줄, 현장 §79 는 일곱 줄이다. 그 차이가 「대표 지시 할 일」과 「줌 안내」이고,
 * 앞의 것은 **그 회차에 걸린 지시가 있을 때만** 선다.
 */
d('§12 준비 줄 (C82-b)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let serId: number;
  let stuA: number;
  const svc = () => new ScheduleService(q.manager.getRepository(SerOcc));
  const onDate = day(-1);

  /**
   * 시각을 매번 다르게 준다 — 같은 강사가 같은 시간에 두 회차를 가지면
   * `ser_occ_teacher_no_overlap` 이 막는다. 이 시험의 관심사는 준비 줄이지 겹침이 아니다.
   */
  let slot = 10;
  const makeSer = async (mode: 'online' | 'offline'): Promise<number> => {
    const hour = slot++;
    const [s] = (await q.query(
      `INSERT INTO ser (kind_key, sub_key, teacher_id, rrule, from_date, mode, start_min, end_min)
       VALUES ('class','sat-math',72,'FREQ=WEEKLY;BYDAY=MO',$1,$2,$3,$4) RETURNING id`,
      [day(-60), mode, hour * 60, hour * 60 + 60],
    )) as Array<{ id: string }>;
    const id = Number(s.id);
    await q.query(`INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2)`, [id, stuA]);
    await q.query(
      `INSERT INTO ser_occ (ser_id, on_date, teacher_id, span)
       VALUES ($1,$2::date,72,tstzrange($2::date + make_time($3,0,0) - interval '9 hours',
                                      $2::date + make_time($3 + 1,0,0) - interval '9 hours'))`,
      [id, onDate, hour],
    );
    return id;
  };

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    slot = 10;
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES (72,'준비 강사','prep@t.kr','teacher')
       ON CONFLICT (id) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO kind (key,name,color,cap,grp,rep,rep_form,sort)
       VALUES ('class','수업','#4A5461',4,'lesson',true,'dev',1)
       ON CONFLICT (key) DO UPDATE SET cap = 4`,
    );
    await q.query(
      `INSERT INTO sub (key,name,color) VALUES ('sat-math','SAT Math','#9C7A38') ON CONFLICT (key) DO NOTHING`,
    );
    const [a] = (await q.query(`INSERT INTO stu (name, grade) VALUES ('준비학생','고1') RETURNING id`)) as Array<{ id: string }>;
    stuA = Number(a.id);
    serId = await makeSer('offline');
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('현장 수업은 일곱 줄이다 — 원본 §79 「준비 4 / 7」과 같은 수', async () => {
    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.prepTotal).toBe(7);
    expect(t.prep.map((r) => r.label)).toEqual([
      '일정 확정', '강사 배정', '수강 학생', '강의실', '교재 배정', '수업 안내', '강사 피드백',
    ]);
    expect(t.prep.some((r) => r.key === 'zoomNoti')).toBe(false);
    expect(t.prep.some((r) => r.key === 'directive')).toBe(false);
  });

  it('온라인 수업은 「줌 안내」가 더 선다 — 여덟 줄', async () => {
    const online = await makeSer('online');
    const t = (await svc().tracking(online, onDate, true))!;
    expect(t.prepTotal).toBe(8);
    expect(t.prep.map((r) => r.key)).toContain('zoomNoti');
    expect(t.prep.map((r) => r.key)).toContain('zacc');
    expect(t.prep.map((r) => r.key)).not.toContain('room');
  });

  it('회차에 걸린 대표 지시가 있으면 맨 위에 한 줄이 더 선다 — 온라인이면 원본과 같은 아홉 줄', async () => {
    const online = await makeSer('online');
    await q.query(
      `INSERT INTO todo (title, src, ser_id, on_date, done) VALUES ('보강 확인','lesson',$1,$2::date,true)`,
      [online, onDate],
    );
    const t = (await svc().tracking(online, onDate, true))!;
    expect(t.prepTotal).toBe(9);                       // 원본 §12 와 같은 수
    expect(t.prep[0].label).toBe('대표 지시 할 일');
    expect(t.prep[0].detail).toBe('1/1 끝남');          // 원본의 낱말 그대로
    expect(t.prep[0].done).toBe(true);
  });

  it('지시가 아직 안 끝났으면 그 줄은 안 된 것이다', async () => {
    await q.query(
      `INSERT INTO todo (title, src, ser_id, on_date, done) VALUES ('교재 준비','lesson',$1,$2::date,false)`,
      [serId, onDate],
    );
    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.prep[0].detail).toBe('0/1 끝남');
    expect(t.prep[0].done).toBe(false);
  });

  it('머리 숫자와 남은 수는 서버가 센다 — 화면이 prep 를 다시 세지 않는다 (D-R37)', async () => {
    const t = (await svc().tracking(serId, onDate, true))!;
    expect(t.prepDone).toBe(t.prep.filter((r) => r.done).length);
    expect(t.prepRemainLabel).toBe(`${t.prepTotal - t.prepDone}가지 남았습니다`);
  });

  it('줄마다의 부제도 서버의 낱말이다 — 「1명 / 정원 4명 · 준비학생」', async () => {
    const t = (await svc().tracking(serId, onDate, true))!;
    const roster = t.prep.find((r) => r.key === 'roster')!;
    expect(roster.detail).toBe('1명 / 정원 4명 · 준비학생');
    const book = t.prep.find((r) => r.key === 'book')!;
    expect(book.detail).toBe('준비학생 없음');          // 원본 「이담흔 없음」과 같은 모양
    expect(book.done).toBe(false);
  });

  it('줌 안내는 학부모와 강사를 따로 적는다 — 학부모는 보낼 곳이 없다 (N-42)', async () => {
    const online = await makeSer('online');
    const before = (await svc().tracking(online, onDate, true))!;
    expect(before.prep.find((r) => r.key === 'zoomNoti')!.detail).toBe('학부모 없음 · 강사 대기');

    await q.query(
      `INSERT INTO pnoti (ser_id, on_date, audience, staff_id, channel, body, sent_at)
       VALUES ($1,$2::date,'teacher',72,'email','줌 링크', now())`,
      [online, onDate],
    );
    const after = (await svc().tracking(online, onDate, true))!;
    const row = after.prep.find((r) => r.key === 'zoomNoti')!;
    expect(row.detail).toBe('학부모 없음 · 강사 보냄');
    expect(row.done).toBe(true);
  });

  it('강사 줌 안내는 회차마다 한 번이다 — 두 줄이 남지 않는다', async () => {
    const online = await makeSer('online');
    const ins = () => q.query(
      `INSERT INTO pnoti (ser_id, on_date, audience, staff_id, channel, body, sent_at)
       VALUES ($1,$2::date,'teacher',72,'email','줌 링크', now())`,
      [online, onDate],
    );
    await ins();
    await expect(ins()).rejects.toThrow();
  });

  it('학부모 행은 학생을, 강사 행은 강사를 가리킨다 — 섞이면 DB 가 막는다', async () => {
    await expect(q.query(
      `INSERT INTO pnoti (ser_id, on_date, audience, staff_id, student_id, channel, body)
       VALUES ($1,$2::date,'teacher',72,$3,'email','섞인 행')`,
      [serId, onDate, stuA],
    )).rejects.toThrow();
  });
});
