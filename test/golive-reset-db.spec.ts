/** @file-guide
 * 목적: golive-reset-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W8 운영 전환(시험 자료 지우기) — 분류 · 지우는 순서 · 남는 표 정리 · 인자 거절 (대표 지시 2026-09-26).
 *
 * DB 시험은 **스크래치 DB(`_test`)에서 한 트랜잭션으로 돌고 끝에 되돌린다** — 픽스처도, 지운 것도, 시험용으로
 * 설정 표에 잠깐 붙인 칸도 남지 않는다. 실제 스크립트(`npm run golive:reset`)는 사람이 자기 DB 에서만 돌린다.
 */
import * as bcrypt from 'bcryptjs';
import { DataSource, type QueryRunner } from 'typeorm';
import { INITIAL_PASSWORD } from '../src/lib/account-policy';
import {
  GOLIVE_KEEP_TABLES, applyGoLive, applyRefusal, classifyTables, deleteOrder, keptFixAction, parseGoLiveArgs, planGoLive,
  type FkEdge, type GoLivePlan,
} from '../src/lib/golive-reset';
import { DEV_URL, TEST_URL, assertScratch } from './db';

const fk = (table: string, refTable: string, notNull = false): FkEdge => ({ table, column: `${refTable}_id`, refTable, notNull, onDelete: 'a' });

describe('운영 전환 — 순수 판정', () => {
  it('설정 표는 남기고 migrations 는 안 건드리며 staff 는 일부 · 나머지는 전부 비운다(새 표는 저절로 비움 쪽)', () => {
    const c = classifyTables(['stu', 'kind', 'staff', 'migrations', 'tzg', 'brand_new_table', 'log']);
    expect(c.keep).toEqual(['kind', 'tzg']);
    expect(c.untouched).toEqual(['migrations']);
    expect(c.partial).toEqual(['staff']);
    expect(c.empty).toEqual(['brand_new_table', 'log', 'stu']);
    expect(GOLIVE_KEEP_TABLES).toEqual(['kind', 'sub', 'room', 'tzg', 'zacc', 'gpasvc', 'holiday', 'gtpl']);
  });

  it('지우는 순서는 가리키는 표가 먼저 · 자기 참조는 무시 · 서로 가리키면 순서를 지어내지 않고 던진다', () => {
    const order = deleteOrder(['staff', 'ser', 'ser_occ', 'att', 'tree'], [
      fk('ser_occ', 'ser'), fk('att', 'ser_occ'), fk('ser', 'staff'), fk('ser_occ', 'staff'), fk('tree', 'tree'), fk('ser', 'kind'),
    ]);
    expect(order.indexOf('att')).toBeLessThan(order.indexOf('ser_occ'));
    expect(order.indexOf('ser_occ')).toBeLessThan(order.indexOf('ser'));
    expect(order.indexOf('ser')).toBeLessThan(order.indexOf('staff'));
    expect(order).toContain('tree');
    expect(() => deleteOrder(['a', 'b', 'c'], [fk('a', 'b'), fk('b', 'a')])).toThrow(/서로 가리키는 표가 있습니다: a, b/);
  });

  it('남는 줄이 지워질 줄을 가리키면 — 비울 수 있으면 NULL · staff 를 가리키는 NOT NULL 은 남길 대표로 · 그 밖은 멈춤', () => {
    expect(keptFixAction({ notNull: false, refTable: 'stu' })).toBe('set_null');
    expect(keptFixAction({ notNull: false, refTable: 'staff' })).toBe('set_null');
    expect(keptFixAction({ notNull: true, refTable: 'staff' })).toBe('reassign_ceo');
    expect(keptFixAction({ notNull: true, refTable: 'stu' })).toBe('abort');
  });

  it('--apply 는 지금 DB 이름과 같은 --confirm · 활성 대표 --keep-email 이 있어야 하고, 모르는 인자는 늘 거절한다', () => {
    const plan = { database: 'taco_x', keptCeo: { id: 1, name: '대표', emailMasked: 'ce***@t.kr' }, keepEmailProblem: null, blockers: [] } as unknown as GoLivePlan;
    expect(applyRefusal(parseGoLiveArgs([]), plan)).toBeNull();
    expect(applyRefusal(parseGoLiveArgs(['--aply']), plan)).toMatch(/모르는 인자/);
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--keep-email=a@t.kr']), plan)).toMatch(/--confirm/);
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--confirm=taco_prod', '--keep-email=a@t.kr']), plan)).toMatch(/지금 DB 이름과 다릅니다/);
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--confirm=taco_x']), plan)).toMatch(/--keep-email/);
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--confirm=taco_x', '--keep-email=a@t.kr']), { ...plan, keepEmailProblem: '활성 대표가 아님' })).toBe('활성 대표가 아님');
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--confirm=taco_x', '--keep-email=a@t.kr']), { ...plan, blockers: ['zacc.x → stu 1줄'] })).toMatch(/멈춥니다/);
    expect(applyRefusal(parseGoLiveArgs(['--apply', '--confirm=taco_x', '--keep-email=a@t.kr']), plan)).toBeNull();
  });
});

const URL = DEV_URL ? assertScratch(TEST_URL) : undefined;
const d = URL ? describe : describe.skip;
jest.setTimeout(120_000);

d('운영 전환 — 스크래치 DB 에서 한 트랜잭션으로 (끝에 되돌린다)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const CEO = 8871; const CEO_OFF = 8872; const CEO2 = 8873; const MGR = 8874; const T = 8875;
  const STU = 8876;
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => ((await q.query(sql, p)) as T[])[0];
  const count = async (t: string) => Number((await one<{ n: string }>(`SELECT count(*)::bigint AS n FROM "${t}"`))!.n);

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', url: URL, synchronize: false, logging: false });
    await ds.initialize();
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const hash = await bcrypt.hash('fixture-1234', 4);
    await q.query(
      `INSERT INTO staff (id, name, email, phone, role, password_hash, active, phone_verified, email_verified) VALUES
         ($1,'남길대표','Keep-Ceo@T.kr','01012345678','ceo',$6,true,true,true),
         ($2,'그만둔대표','off-ceo@t.kr',NULL,'ceo',$6,false,false,false),
         ($3,'둘째대표','ceo2@t.kr',NULL,'ceo',$6,true,false,false),
         ($4,'시험매니저','m@t.kr',NULL,'manager',$6,true,false,false),
         ($5,'시험강사','t@t.kr',NULL,'teacher',$6,true,false,false)`,
      [CEO, CEO_OFF, CEO2, MGR, T, hash],
    );
    await q.query(`INSERT INTO tzg (id, name, tz) VALUES (8871,'시험 시간대','Asia/Seoul') ON CONFLICT (id) DO NOTHING`);
    await q.query(`INSERT INTO holiday (on_date, name) VALUES ('2031-01-01','시험 휴일') ON CONFLICT DO NOTHING`);
    await q.query(`INSERT INTO stu (id, name, grade) VALUES ($1,'시험학생','10')`, [STU]);
    await q.query(`INSERT INTO wage (staff_id, rate, from_date, reason) VALUES ($1, 40000, '2026-01-01', '시험')`, [T]);
    await q.query(`INSERT INTO todo (title, from_id, to_id, src) VALUES ('시험 할 일', $1, $2, 'manual')`, [MGR, T]);
    await q.query(`INSERT INTO noti (to_id, from_id, body) VALUES ($1, $2, '시험 알림')`, [T, MGR]);
    await q.query(`INSERT INTO log (actor_id, entity, entity_id, action) VALUES ($1,'STAFF',$2,'create')`, [MGR, T]);
    await q.query(`INSERT INTO pnoti (channel, body, audience, staff_id) VALUES ('app','시험','teacher',$1)`, [T]);
    await q.query(`INSERT INTO auth_code (staff_id, channel, target_hash, target_masked, code_hash, expires_at)
                   VALUES ($1,'email',repeat('a',64),'ke***@t.kr',repeat('b',64), now() + interval '10 minutes')`, [CEO]);
    /* 설정 표가 지워질 줄을 가리키는 경우 — 실제 스키마에는 없어서 **이 트랜잭션 안에서만** 칸을 붙여 본다(DDL 도 되돌려진다) */
    await q.query(`ALTER TABLE gtpl ADD COLUMN w8b_owner bigint REFERENCES staff(id)`);
    await q.query(`ALTER TABLE room ADD COLUMN w8b_by bigint REFERENCES staff(id)`);
    await q.query(`INSERT INTO gtpl (id, name, body, w8b_owner) VALUES (8871,'시험 틀','본문',$1)`, [T]);
    await q.query(`INSERT INTO room (id, branch, name, capacity, active, w8b_by) VALUES (8871,'본관','시험실',4,true,$1)`, [MGR]);
    // 다른 강의실 줄은 남길 대표를 가리키게 둔다 — NOT NULL 을 걸 수 있게(남는 줄끼리는 정리 대상이 아니다)
    await q.query(`UPDATE room SET w8b_by = $1 WHERE w8b_by IS NULL`, [CEO]);
    await q.query(`ALTER TABLE room ALTER COLUMN w8b_by SET NOT NULL`);
  });

  afterAll(async () => {
    try {
      if (q?.isTransactionActive) await q.rollbackTransaction();
      await q?.release();
    } finally {
      if (ds?.isInitialized) await ds.destroy();
    }
  });

  it('실제 스키마의 지우는 순서 — 순환이 없고, FK 가 있는 모든 줄에서 가리키는 표가 먼저다', async () => {
    const plan = await planGoLive(q);
    const pos = new Map(plan.order.map((t, i) => [t, i]));
    const edges = (await q.query(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype = 'f'`,
    )) as Array<{ child: string; parent: string }>;
    for (const e of edges) {
      if (e.child === e.parent || !pos.has(e.child) || !pos.has(e.parent)) continue;
      expect([e.child, pos.get(e.child)! < pos.get(e.parent)!]).toEqual([e.child, true]);
    }
    expect(plan.order).toContain('staff');
    expect(plan.order).not.toContain('migrations');
    for (const k of GOLIVE_KEEP_TABLES) expect(plan.order).not.toContain(k);
  });

  it('미리 보기 — 대표를 안 고르면 계정 전부가 지움 쪽이고, 활성 대표 목록은 가린 이메일로만 나온다', async () => {
    const plan = await planGoLive(q);
    expect(plan.database).toMatch(/_test$/);
    expect(plan.keptCeo).toBeNull();
    expect(plan.staff.delete).toBe(plan.staff.rows);
    expect(plan.activeCeos.map((c) => c.id)).toEqual(expect.arrayContaining([CEO, CEO2]));
    expect(plan.activeCeos.map((c) => c.id)).not.toContain(CEO_OFF);
    expect(JSON.stringify(plan.activeCeos)).not.toMatch(/keep-ceo@t\.kr/i);
    expect(plan.empty.find((e) => e.table === 'wage')!.rows).toBeGreaterThanOrEqual(1);
  });

  it('남길 대표는 활성 대표여야 한다 — 그만둔 대표 · 매니저 · 없는 이메일은 막히고 아무것도 안 바뀐다', async () => {
    for (const email of ['off-ceo@t.kr', 'm@t.kr', 'nobody@t.kr']) {
      const plan = await planGoLive(q, email);
      expect(plan.keptCeo).toBeNull();
      expect(plan.keepEmailProblem).toMatch(/활성 대표/);
      await expect(applyGoLive(q, email)).rejects.toThrow(/활성 대표/);
    }
    expect(await count('wage')).toBeGreaterThanOrEqual(1);
  });

  it('설정 표의 NOT NULL 칸이 지워질 **staff 가 아닌** 줄을 가리키면 멈춘다 — 바꾸기 전이다', async () => {
    await q.query('SAVEPOINT blocked');
    await q.query(`ALTER TABLE zacc ADD COLUMN w8b_stu bigint REFERENCES stu(id)`);
    await q.query(`INSERT INTO zacc (id, label, login_email, login_secret, join_url, active, w8b_stu)
                   VALUES (8871,'시험 줌','z@t.kr','\\x00'::bytea,'https://zoom.us/j/1',true,$1)`, [STU]);
    await q.query(`UPDATE zacc SET w8b_stu = $1 WHERE w8b_stu IS NULL`, [STU]);
    await q.query(`ALTER TABLE zacc ALTER COLUMN w8b_stu SET NOT NULL`);
    const plan = await planGoLive(q, 'keep-ceo@t.kr');
    expect(plan.blockers).toEqual([expect.stringMatching(/^zacc\.w8b_stu → stu \d+줄/)]);
    expect(applyRefusal(parseGoLiveArgs(['--apply', `--confirm=${plan.database}`, '--keep-email=keep-ceo@t.kr']), plan)).toMatch(/멈춥니다/);
    await expect(applyGoLive(q, 'keep-ceo@t.kr')).rejects.toThrow(/멈춥니다/);
    expect(await count('stu')).toBeGreaterThanOrEqual(1);
    await q.query('ROLLBACK TO SAVEPOINT blocked');
  });

  it('지우기 — 설정 표는 그대로 · 나머지는 0 · 계정은 남길 대표 하나 · 그 대표는 초기 비밀번호 + 첫 설정 · 남는 줄은 NULL/대표로 정리 · 흔적 한 줄', async () => {
    const plan = await planGoLive(q, ' KEEP-CEO@t.kr ');
    expect(plan.keptCeo?.id).toBe(CEO);
    expect(plan.fixes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'gtpl', column: 'w8b_owner', action: 'set_null', rows: 1 }),
      expect.objectContaining({ table: 'room', column: 'w8b_by', action: 'reassign_ceo', rows: 1 }),
    ]));
    const keptBefore = new Map<string, number>();
    for (const k of plan.keep) keptBefore.set(k.table, await count(k.table));

    const res = await applyGoLive(q, 'keep-ceo@t.kr');
    expect(res.staffDeleted).toBe(plan.staff.delete);
    for (const k of plan.keep) expect([k.table, await count(k.table)]).toEqual([k.table, keptBefore.get(k.table)]);
    for (const e of plan.empty) {
      // log 는 지운 뒤 흔적 한 줄이 선다
      expect([e.table, await count(e.table)]).toEqual([e.table, e.table === 'log' ? 1 : 0]);
    }
    const staff = (await q.query(
      `SELECT id, password_hash, must_change_credentials, email_verified, phone_verified, credentials_changed_at, active FROM staff`,
    )) as Array<Record<string, unknown>>;
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ must_change_credentials: true, email_verified: false, phone_verified: false, active: true });
    expect(Number(staff[0].id)).toBe(CEO);
    expect(staff[0].credentials_changed_at).not.toBeNull();
    expect(await bcrypt.compare(INITIAL_PASSWORD, String(staff[0].password_hash))).toBe(true);
    expect(await one(`SELECT w8b_owner FROM gtpl WHERE id = 8871`)).toEqual({ w8b_owner: null });
    expect(Number((await one<{ w8b_by: string }>(`SELECT w8b_by FROM room WHERE id = 8871`))!.w8b_by)).toBe(CEO);
    const log = await one<{ actor_id: string; action: string; after: Record<string, unknown> }>(`SELECT actor_id, action, after FROM log`);
    expect(log).toMatchObject({ action: 'golive_reset' });
    expect(Number(log!.actor_id)).toBe(CEO);
    expect(JSON.stringify(log!.after)).not.toMatch(/@|password|hash|tnacademy/i);
  });
});
