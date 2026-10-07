/** @file-guide
 * 목적: §29 생성부터 §30 파일→피드백→전달→서명→수납 전이를 실제 Postgres에서 검증한다.
 * 책임/재사용: ConsultingService 공개 메서드와 DB 제약을 함께 검증하고 스크래치 트랜잭션 밖에 데이터를 남기지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { randomUUID } from 'crypto';
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
    requestKey: randomUUID(),
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

    await expect(svc().create(owner, false, false, input({ consType: 'essay', studentIds: [studentA] })))
      .rejects.toMatchObject({ response: { code: 'CONS_TEMPLATE_MISSING' } });
  });

  it('날짜 순서·없는 학생·강사 담당·지정 공개 조건을 서버에서 다시 막는다', async () => {
    await expect(svc().create(owner, false, false, input({ startOn: '2026-12-21' })))
      .rejects.toMatchObject({ response: { code: 'CONS_DATE_ORDER' } });
    await expect(svc().create(owner, false, false, input({ studentIds: [9_999_999] })))
      .rejects.toMatchObject({ response: { code: 'CONS_STUDENT_INVALID' } });
    await expect(svc().create(owner, false, false, input({ ownerId: teacher, studentIds: [studentA] })))
      .resolves.toMatchObject({ ownerId: teacher });
    await expect(svc().create(owner, false, false, input({ share: 'picked' })))
      .rejects.toMatchObject({ response: { code: 'CONS_PICK_REQUIRED' } });
    await expect(svc().create(owner, false, false, input({ pickedStaffIds: [picked] })))
      .rejects.toMatchObject({ response: { code: 'CONS_PICK_FORBIDDEN' } });
  });

  it('최초 등록자는 지정 공개에서도 전체 내용을 되읽고 비공개 지정 권한은 별도로 지킨다', async () => {
    const [{ before }] = await q.query(`SELECT count(*)::int AS before FROM cons`);
    // 비공개는 **지정 자체가 대표 전용**이라 자기 잠금보다 먼저 걸린다 — 권한이 먼저다 (S4 · §76)
    await expect(svc().create(picked, false, false, input({ share: 'private' })))
      .rejects.toMatchObject({ response: { code: 'CONS_PRIVATE_FORBIDDEN' } });
    await expect(svc().create(picked, false, false, input({ share: 'picked', pickedStaffIds: [owner] })))
      .resolves.toMatchObject({ createdBy: picked, share: 'picked' });
    const [{ after }] = await q.query(`SELECT count(*)::int AS after FROM cons`);
    expect(after).toBe(before + 1);
  });

  it('기본 항목 설정은 유형별 immutable version으로 저장하고 replay·stale·key 재사용을 구분한다', async () => {
    const requestKey = randomUUID();
    const command = {
      expectedVersion: 0,
      requestKey,
      items: [{ label: '에세이 초안', required: true }, { label: '최종 교정', required: false }],
    };
    const first = await svc().writeTemplate(owner, 'essay', command);
    expect(first).toMatchObject({ consType: 'essay', version: 1, enabled: true, items: command.items.map((item, index) => ({ ...item, seq: index + 1 })) });
    expect(await svc().writeTemplate(owner, 'essay', command)).toEqual(first);
    await expect(svc().writeTemplate(owner, 'essay', { ...command, items: [{ label: '다른 항목', required: true }] }))
      .rejects.toMatchObject({ response: { code: 'CONS_TEMPLATE_REQUEST_KEY_REUSED' } });
    await expect(svc().writeTemplate(owner, 'essay', { ...command, requestKey: randomUUID() }))
      .rejects.toMatchObject({ response: { code: 'CONS_TEMPLATE_VERSION_CONFLICT', actualVersion: 1 } });
    await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    expect(await q.query(`SELECT version,active FROM cons_template WHERE cons_type='essay' ORDER BY version`))
      .toEqual([{ version: 1, active: true }]);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);
  });

  it('기본 항목은 공백 이름을 400으로 막고 custom template의 빈 최종 상태를 DB도 거절한다', async () => {
    await expect(svc().writeTemplate(owner, 'essay', {
      expectedVersion: 0, requestKey: randomUUID(), items: [{ label: '   ', required: true }],
    })).rejects.toMatchObject({ response: { code: 'CONS_TEMPLATE_ITEM_EMPTY' } });

    await q.query(`SAVEPOINT cons_template_empty`);
    const [{ id }] = await q.query(`INSERT INTO cons_template(cons_type,version,created_by) VALUES ('essay',1,$1) RETURNING id`, [owner]);
    await q.query(`INSERT INTO cons_template_write_req(request_key,cons_type,template_id,fingerprint,result_version,actor_id)
      VALUES ($1,'essay',$2,repeat('a',64),1,$3)`, [randomUUID(), id, owner]);
    await expect(q.query(`SET CONSTRAINTS ALL IMMEDIATE`)).rejects.toThrow(/requires 1 to 24 contiguous items/i);
    await q.query(`ROLLBACK TO SAVEPOINT cons_template_empty`);
    await q.query(`RELEASE SAVEPOINT cons_template_empty`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);
  });

  it('생성은 같은 requestKey를 같은 건으로 replay하고 다른 본문은 409이며 미설정 유형은 행을 남기지 않는다', async () => {
    const command = input({ studentIds: [studentA], ownerId: teacher });
    const first = await svc().create(owner, false, false, command);
    const replay = await svc().create(owner, false, false, command);
    expect(replay.id).toBe(first.id);
    expect(replay.ownerId).toBe(teacher);
    await expect(svc().create(owner, false, false, { ...command, amount: command.amount + 1 }))
      .rejects.toMatchObject({ response: { code: 'CONS_REQUEST_KEY_REUSED' } });
    const before = Number((await q.query(`SELECT count(*)::int AS n FROM cons`))[0].n);
    await expect(svc().create(owner, false, false, input({ consType: 'essay', studentIds: [studentA] })))
      .rejects.toMatchObject({ response: { code: 'CONS_TEMPLATE_MISSING' } });
    expect(Number((await q.query(`SELECT count(*)::int AS n FROM cons`))[0].n)).toBe(before);
    await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    expect(await q.query(`SELECT action,result_version FROM cons_write_req WHERE cons_id=$1`, [first.id]))
      .toEqual([{ action: 'create', result_version: 1 }]);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);
  });

  it('핵심정보 수정은 한 transaction에서 version을 올리고 replay·stale 충돌 때 학생 연결도 보존한다', async () => {
    const made = await svc().create(owner, true, false, input({ studentIds: [studentA] }));
    const requestKey = randomUUID();
    const command = { expectedVersion: made.version!, requestKey, studentIds: [studentB], ownerId: teacher, amount: 1_200_000 };
    const changed = await svc().updateCore(owner, true, false, made.id, command);
    expect(changed).toMatchObject({ version: 2, studentIds: [studentB], ownerId: teacher, amount: 1_200_000 });
    expect(await svc().updateCore(owner, true, false, made.id, command)).toEqual(changed);
    await expect(svc().updateCore(owner, true, false, made.id, {
      expectedVersion: made.version!, requestKey: randomUUID(), studentIds: [studentA], amount: 2_000_000,
    })).rejects.toMatchObject({ response: { code: 'CONS_VERSION_CONFLICT', actualVersion: 2 } });
    const current = await svc().detail(owner, true, false, made.id);
    expect(current).toMatchObject({ version: 2, studentIds: [studentB], ownerId: teacher, amount: 1_200_000 });
    await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);
  });

  it('직접 SQL은 template·CONS 생성과 version 수정에서 writer receipt 우회를 지연 제약으로 막는다', async () => {
    const made = await svc().create(owner, true, false, input({ studentIds: [studentA] }));
    await q.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);

    await q.query(`SAVEPOINT cons_direct_update`);
    await q.query(`UPDATE cons SET amount=amount+1,row_version=row_version+1 WHERE id=$1`, [made.id]);
    await expect(q.query(`SET CONSTRAINTS ALL IMMEDIATE`)).rejects.toThrow(/consulting version receipt required/i);
    await q.query(`ROLLBACK TO SAVEPOINT cons_direct_update`);
    await q.query(`RELEASE SAVEPOINT cons_direct_update`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);

    const [{ id: templateId }] = await q.query(`SELECT id FROM cons_template WHERE cons_type='admissions' AND active`);
    await q.query(`SAVEPOINT cons_direct_insert`);
    await q.query(`INSERT INTO cons(cons_type,stage,contract_step,created_by,template_id) VALUES ('admissions','contract',1,$1,$2)`, [owner, templateId]);
    await expect(q.query(`SET CONSTRAINTS ALL IMMEDIATE`)).rejects.toThrow(/consulting writer receipt required/i);
    await q.query(`ROLLBACK TO SAVEPOINT cons_direct_insert`);
    await q.query(`RELEASE SAVEPOINT cons_direct_insert`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);

    await q.query(`SAVEPOINT cons_template_direct_insert`);
    await q.query(`UPDATE cons_template SET active=false WHERE cons_type='admissions' AND active`);
    const [{ id: directTemplateId }] = await q.query(`INSERT INTO cons_template(cons_type,version,created_by) VALUES ('admissions',2,$1) RETURNING id`, [owner]);
    await q.query(`INSERT INTO cons_template_item(template_id,seq,label,required) VALUES ($1,1,'직접 항목',true)`, [directTemplateId]);
    await expect(q.query(`SET CONSTRAINTS ALL IMMEDIATE`)).rejects.toThrow(/consulting template writer receipt required/i);
    await q.query(`ROLLBACK TO SAVEPOINT cons_template_direct_insert`);
    await q.query(`RELEASE SAVEPOINT cons_template_direct_insert`);
    await q.query(`SET CONSTRAINTS ALL DEFERRED`);
  });

  it('공개 범위 변경으로 호출자 자신이 잠기면 기존 share와 지정 목록을 보존한다', async () => {
    const made = await svc().create(owner, false, false, input({ studentIds: [studentA], share: 'all' }));
    // 여기서도 권한이 먼저다 (S4) — 자기 잠금은 아래 「지정 공개」 줄이 그대로 본다
    await expect(svc().updateShare(picked, false, false, made.id, { share: 'private', expectedVersion: made.version!, requestKey: randomUUID() }))
      .rejects.toMatchObject({ response: { code: 'CONS_PRIVATE_FORBIDDEN' } });
    await expect(svc().updateShare(picked, false, false, made.id, { share: 'picked', pickedStaffIds: [owner], expectedVersion: made.version!, requestKey: randomUUID() }))
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

    expect((await svc().addPayment(owner, true, false, made.id, { requestKey: randomUUID(), amount: 400_000, paidOn: todayKst() })).stage).toBe('contract');
    await expect(svc().addPayment(owner, true, false, made.id, { requestKey: randomUUID(), amount: 600_001, paidOn: todayKst() }))
      .rejects.toMatchObject({ response: { code: 'OVERPAY' } });
    expect((await svc().addPayment(owner, true, false, made.id, { requestKey: randomUUID(), amount: 600_000, paidOn: todayKst() })).stage).toBe('running');
    await expect(svc().addPayment(owner, true, false, made.id, { requestKey: randomUUID(), amount: 1, paidOn: todayKst() }))
      .rejects.toMatchObject({ response: { code: 'OVERPAY' } });
    // 단계 잠금을 보는 줄이므로 **비공개 지정 권한은 주고**(canHide=true) 부른다 — S4 가 그 앞에 문을 하나 세웠다
    const beforeShare = await svc().detail(owner, true, true, made.id);
    await expect(svc().updateShare(owner, true, true, made.id, { share: 'private', expectedVersion: beforeShare.version!, requestKey: randomUUID() }))
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
