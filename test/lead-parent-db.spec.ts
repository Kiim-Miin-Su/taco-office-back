/** @file-guide
 * 목적: lead-parent-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { makeOpsService } from './ops-svc';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(60_000);

/**
 * A-01 「카카오채널로 신규 문의 — ② 이름 · 학년 · 학교 ③ 학부모 어머니 · 연락처 010-1234-5678 ④ 유입 경로 ⑤ 원하는 것」.
 * 전에는 학부모 · 연락처 · 원하는 것이 **접촉 원장의 자유 글 한 줄**에 섞였다(N-42 때의 판단) — 그래서 카드에 「원하는 것」을
 * 올리지 못했고(연락처가 섞일 수 있다 · 23-11) 등록 뒤 보호자로 이어 줄 수도 없었다. 이제 칸이 셋이다.
 * 이 스위트 전용 staff 54 를 쓴다(시드 번호를 빌리지 않는다 · C74).
 */
d('A-01 문의의 학부모 · 연락처 · 원하는 것', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const svc = () => makeOpsService(q.manager.getRepository(Lead));

  beforeAll(async () => {
    const url = assertScratch(TEST_URL);
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: /sslmode=require|sslmode=verify|neon\.tech/.test(url) ? { rejectUnauthorized: false } : false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role) VALUES (54,'접수자54','lead54@t.kr','manager') ON CONFLICT (id) DO NOTHING`);
    await q.query(`UPDATE staff SET active = true WHERE id = 54`);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('접수 — 학부모 · 연락처(숫자만 저장 · 보이는 모양은 서버) · 원하는 것이 칸으로 남고, 감사 줄에는 가린 번호만', async () => {
    const out = await svc().createLead(54, {
      name: '카카오학생', grade: 'G8', school: '역삼중', source: 'kakao',
      parentRelation: ' 어머니 ', parentPhone: '010-1234-5678', want: ' MAP Reading 점수 올리기 ',
    });
    expect(out).toMatchObject({
      name: '카카오학생', grade: 'G8', school: '역삼중', stage: 'first', source: 'kakao',
      parentRelation: '어머니', parentPhone: '01012345678', parentPhoneDisplay: '010-1234-5678', want: 'MAP Reading 점수 올리기',
    });
    // 첫 접촉 한 줄을 안 적었으면 접촉 원장은 비어 있다 — 칸에 적은 것을 원장에 옮겨 적지 않는다(두 곳이면 갈린다)
    expect(out.touches).toEqual([]);
    const [row] = await q.query(`SELECT parent_relation, parent_phone, want FROM lead WHERE id = $1`, [out.id]);
    expect(row).toEqual({ parent_relation: '어머니', parent_phone: '01012345678', want: 'MAP Reading 점수 올리기' });
    const [log] = await q.query(`SELECT after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'create'`, [out.id]);
    expect(log.after).toMatchObject({ parentRelation: '어머니', parentPhone: '010-****-5678', want: 'MAP Reading 점수 올리기' });
    expect(JSON.stringify(log.after)).not.toContain('01012345678');
    expect(JSON.stringify(log.after)).not.toContain('1234-5678');
  });

  it('비우면 셋 다 null — 옛 건과 같은 모양(N-25) · 휴대폰 모양이 아니면 거절하고 아무것도 남기지 않는다', async () => {
    const out = await svc().createLead(54, { name: '빈칸학생', source: 'phone', parentRelation: '  ', parentPhone: '', want: '' });
    expect(out).toMatchObject({ parentRelation: null, parentPhone: null, parentPhoneDisplay: null, want: null });
    const before = await q.query(`SELECT count(*)::int AS n FROM lead`);
    await expect(svc().createLead(54, { name: '번호틀림', source: 'phone', parentPhone: '1234' }))
      .rejects.toMatchObject({ response: { code: 'LEAD_PARENT_PHONE' } });
    expect(await q.query(`SELECT count(*)::int AS n FROM lead`)).toEqual(before);
    // 표가 마지막에 막는다 — 서비스를 건너뛴 값도 CHECK 가 거절한다
    await q.query('SAVEPOINT chk');
    // 길이(11)는 맞지만 숫자만이 아니다 — 모양 CHECK 가 막는다
    await expect(q.query(`INSERT INTO lead (name, stage, parent_phone) VALUES ('x','first','010-123-45')`))
      .rejects.toMatchObject({ constraint: 'lead_parent_phone_digits' });
    await q.query('ROLLBACK TO SAVEPOINT chk');
  });

  it('카드 머리 고치기 — 보낸 칸만 바꾸고 null 은 비운다 · 감사 줄 앞뒤 모두 가린 번호', async () => {
    const made = await svc().createLead(54, { name: '고칠학생', source: 'referral', parentRelation: '아버지', parentPhone: '01099998888', want: '겨울 특강' });
    const out = await svc().patchLead(54, made.id, { parentPhone: '010-2222-3333', want: null });
    expect(out).toMatchObject({ parentRelation: '아버지', parentPhone: '01022223333', parentPhoneDisplay: '010-2222-3333', want: null });
    const [log] = await q.query(`SELECT before, after FROM log WHERE entity = 'LEAD' AND entity_id = $1 AND action = 'edit'`, [made.id]);
    expect(log.before).toMatchObject({ parentPhone: '010-****-8888', want: '겨울 특강' });
    expect(log.after).toMatchObject({ parentPhone: '010-****-3333', want: null });
    await expect(svc().patchLead(54, made.id, { parentPhone: 'abc' })).rejects.toMatchObject({ response: { code: 'LEAD_PARENT_PHONE' } });
  });
});
