/** @file-guide
 * 목적: §29 생성부터 §30 파일→피드백→전달→서명→수납 전이를 실제 Postgres에서 검증한다.
 * 책임/재사용: ConsultingService 공개 메서드와 DB 제약을 함께 검증하고 스크래치 트랜잭션 밖에 데이터를 남기지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { ConsultingService } from '../src/modules/consulting/consulting.service';
import type { ConsultingCreateDto } from '../src/modules/consulting/consulting.dto';
import { todayKst } from '../src/lib/kst';
import { assertScratch, TEST_URL } from './db';

const d = TEST_URL ? describe : describe.skip;
const url = TEST_URL ? assertScratch(TEST_URL) : '';
jest.setTimeout(60_000);

function scratchDataSource(): DataSource {
  if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
  return new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
}

d('§29·§30 컨설팅 계약 워크플로 (C79-product)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  let studentA: number;
  let studentB: number;
  const owner = 2791;
  const picked = 2792;
  const teacher = 2793;
  const svc = () => new ConsultingService(q.manager.getRepository(Lead));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(`INSERT INTO staff (id,name,email,role,active) VALUES
      ($1,'계약 담당','c79-owner@test','manager',true),
      ($2,'지정 관리자','c79-picked@test','admin',true),
      ($3,'담당 불가 강사','c79-teacher@test','teacher',true)
      ON CONFLICT (id) DO UPDATE SET active=true`, [owner, picked, teacher]);
    studentA = Number((await q.query(`INSERT INTO stu (name) VALUES ('C79 학생 A') RETURNING id`))[0].id);
    studentB = Number((await q.query(`INSERT INTO stu (name) VALUES ('C79 학생 B') RETURNING id`))[0].id);
  });
  afterEach(async () => { if (q?.isTransactionActive) await q.rollbackTransaction(); if (q && !q.isReleased) await q.release(); });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  const input = (patch: Partial<ConsultingCreateDto> = {}): ConsultingCreateDto => ({
    consType: 'admissions', studentIds: [studentA, studentB], requester: 'mother', ownerId: owner,
    amount: 1_000_000, sessions: 8, startOn: '2026-09-14', endOn: '2026-12-20', share: 'all',
    ...patch,
  });

  it('서버가 계약 1단계로 만들고 국제학교 7항목만 자동 생성한다', async () => {
    const made = await svc().create(owner, false, false, input());
    expect(made).toMatchObject({
      consType: 'admissions', consTypeLabel: '국제학교 지원', stage: 'contract', contractStep: 1,
      requester: 'mother', startOn: '2026-09-14', endOn: '2026-12-20', amount: 1_000_000,
      studentIds: expect.arrayContaining([studentA, studentB]),
      typeCapability: { defaultItemsSupported: true, reason: null },
    });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM cons_item WHERE cons_id=$1`, [made.id]))[0].n)).toBe(7);

    const essay = await svc().create(owner, false, false, input({ consType: 'essay', studentIds: [studentA] }));
    expect(essay.typeCapability).toMatchObject({ defaultItemsSupported: false });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM cons_item WHERE cons_id=$1`, [essay.id]))[0].n)).toBe(0);
  });

  it('날짜 순서·없는 학생·강사 담당·지정 공개 조건을 서버에서 다시 막는다', async () => {
    await expect(svc().create(owner, false, false, input({ startOn: '2026-12-21' })))
      .rejects.toMatchObject({ response: { code: 'CONS_DATE_ORDER' } });
    await expect(svc().create(owner, false, false, input({ studentIds: [9_999_999] })))
      .rejects.toMatchObject({ response: { code: 'CONS_STUDENT_INVALID' } });
    await expect(svc().create(owner, false, false, input({ ownerId: teacher })))
      .rejects.toMatchObject({ response: { code: 'CONS_STAFF_INVALID' } });
    await expect(svc().create(owner, false, false, input({ share: 'picked' })))
      .rejects.toMatchObject({ response: { code: 'CONS_PICK_REQUIRED' } });
    await expect(svc().create(owner, false, false, input({ pickedStaffIds: [picked] })))
      .rejects.toMatchObject({ response: { code: 'CONS_PICK_FORBIDDEN' } });
  });

  it('생성 결과에서 호출자 자신을 잠그는 공개 범위는 행을 만들기 전에 거절한다', async () => {
    const [{ before }] = await q.query(`SELECT count(*)::int AS before FROM cons`);
    await expect(svc().create(picked, false, false, input({ share: 'private' })))
      .rejects.toMatchObject({ response: { code: 'CONS_SELF_LOCKOUT' } });
    await expect(svc().create(picked, false, false, input({ share: 'picked', pickedStaffIds: [owner] })))
      .rejects.toMatchObject({ response: { code: 'CONS_SELF_LOCKOUT' } });
    const [{ after }] = await q.query(`SELECT count(*)::int AS after FROM cons`);
    expect(after).toBe(before);
  });

  it('공개 범위 변경으로 호출자 자신이 잠기면 기존 share와 지정 목록을 보존한다', async () => {
    const made = await svc().create(owner, false, false, input({ studentIds: [studentA], share: 'all' }));
    await expect(svc().updateShare(picked, false, false, made.id, { share: 'private' }))
      .rejects.toMatchObject({ response: { code: 'CONS_SELF_LOCKOUT' } });
    await expect(svc().updateShare(picked, false, false, made.id, { share: 'picked', pickedStaffIds: [owner] }))
      .rejects.toMatchObject({ response: { code: 'CONS_SELF_LOCKOUT' } });
    const [row] = await q.query(`SELECT share,(SELECT count(*)::int FROM cons_pick WHERE cons_id=c.id) AS picks FROM cons c WHERE id=$1`, [made.id]);
    expect(row).toMatchObject({ share: 'all', picks: 0 });
  });

  it('계약서→피드백 해결→학부모 전달→서명본→전액 수납으로만 진행 전이한다', async () => {
    const made = await svc().create(owner, true, false, input({ studentIds: [studentA] }));
    const draft = await svc().addContractFile(owner, false, made.id, { name: '계약서.pdf', base64: Buffer.from('draft').toString('base64') });
    expect(draft).toMatchObject({ role: 'draft', url: `/files/${draft.id}` });
    expect((await svc().detail(owner, true, false, made.id)).contractStep).toBe(2);

    const feedback = await svc().addFeedback(owner, false, made.id, { body: '수업 기간을 확인해 주세요.' });
    await expect(svc().deliverContract(owner, true, false, made.id))
      .rejects.toMatchObject({ response: { code: 'CONS_FEEDBACK_OPEN' } });
    expect((await svc().markFeedbackResolved(owner, false, made.id, feedback.id)).resolved).toBe(true);
    expect((await svc().deliverContract(owner, true, false, made.id)).contractStep).toBe(4);
    const signed = await svc().addSignedFile(owner, false, made.id, { name: '서명본.pdf', base64: Buffer.from('signed').toString('base64') });
    expect(signed.role).toBe('signed');
    expect((await svc().detail(owner, true, false, made.id)).contractStep).toBe(5);

    expect((await svc().addPayment(owner, true, false, made.id, { amount: 400_000, paidOn: todayKst() })).stage).toBe('contract');
    await expect(svc().addPayment(owner, true, false, made.id, { amount: 600_001, paidOn: todayKst() }))
      .rejects.toMatchObject({ response: { code: 'OVERPAY' } });
    expect((await svc().addPayment(owner, true, false, made.id, { amount: 600_000, paidOn: todayKst() })).stage).toBe('running');
    await expect(svc().addPayment(owner, true, false, made.id, { amount: 1, paidOn: todayKst() }))
      .rejects.toMatchObject({ response: { code: 'OVERPAY' } });
    await expect(svc().updateShare(owner, true, false, made.id, { share: 'private' }))
      .rejects.toMatchObject({ response: { code: 'CONS_LOCKED' } });
    const [paymentState] = await q.query(
      `SELECT COALESCE(sum(amount),0)::int AS paid,count(*)::int AS count FROM cons_pay WHERE cons_id=$1`, [made.id],
    );
    expect(paymentState).toMatchObject({ paid: 1_000_000, count: 2 });
  });

  it('전달 뒤 수정본을 올리면 피드백 단계로 돌아가고 재전달 이력을 모두 남긴다', async () => {
    const made = await svc().create(owner, true, false, input({ studentIds: [studentA] }));
    await svc().addContractFile(owner, false, made.id, { name: 'v1.pdf', base64: Buffer.from('v1').toString('base64') });
    await svc().deliverContract(owner, true, false, made.id);
    await svc().addContractFile(owner, false, made.id, { name: 'v2.pdf', base64: Buffer.from('v2').toString('base64') });
    expect((await svc().detail(owner, true, false, made.id)).contractStep).toBe(2);
    await svc().deliverContract(owner, true, false, made.id);
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM cons_event WHERE cons_id=$1 AND event_type='parent_delivered'`, [made.id]))[0].n)).toBe(2);
  });

  it('10개 파일 상한과 DB FK/날짜 제약을 지키고 삭제는 보관 처리한다', async () => {
    const made = await svc().create(owner, false, false, input({ studentIds: [studentA] }));
    for (let i = 0; i < 10; i += 1) {
      await svc().addContractFile(owner, false, made.id, { name: `${i}.pdf`, base64: Buffer.from(String(i)).toString('base64') });
    }
    await expect(svc().addContractFile(owner, false, made.id, { name: '11.pdf', base64: Buffer.from('11').toString('base64') }))
      .rejects.toMatchObject({ response: { code: 'CONS_FILE_LIMIT' } });
    await q.query(`SAVEPOINT c79_dates`);
    await expect(q.query(`UPDATE cons SET start_on='2026-12-31',end_on='2026-01-01' WHERE id=$1`, [made.id])).rejects.toMatchObject({ code: '23514' });
    await q.query(`ROLLBACK TO SAVEPOINT c79_dates`);
    await q.query(`SAVEPOINT c79_fk`);
    await expect(q.query(`INSERT INTO cons_pick (cons_id,staff_id) VALUES ($1,99999999)`, [made.id])).rejects.toMatchObject({ code: '23503' });
    await q.query(`ROLLBACK TO SAVEPOINT c79_fk`);
  });

  it('보관은 자식 원장을 지우지 않고 활성 조회에서만 숨긴다', async () => {
    const made = await svc().create(owner, false, false, input({ studentIds: [studentA] }));
    await svc().archive(owner, false, made.id);
    await expect(svc().detail(owner, false, false, made.id)).rejects.toMatchObject({ status: 404 });
    const [row] = await q.query(`SELECT deleted_at IS NOT NULL AS archived,(SELECT count(*) FROM cons_stu WHERE cons_id=c.id)::int AS students FROM cons c WHERE id=$1`, [made.id]);
    expect(row).toMatchObject({ archived: true, students: 1 });
  });
});
