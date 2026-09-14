/** @file-guide
 * 목적: files-db.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 파일 저장소 — **Neon 안에 둔다** (대표 결정 2026-09-12: 「파일 저장소는 Neon에 올릴 수 있으면 올리기」).
 *
 * 여기서 증명하는 것은 넷이다.
 *   ① 본문이 표에 그대로 들어가고 그대로 나온다 (sha256 이 같다)
 *   ② 길이는 **우리가 다시 센다** — 화면이 보낸 숫자를 믿지 않는다
 *   ③ 한도를 넘으면 조용히 자르지 않고 **거절한다** (그리고 표도 거절한다)
 *   ④ 가리키는 주소는 `/files/{id}` — 저장소가 어디인지 주소 모양으로 갈린다
 */
import { createHash } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { FileRow } from '../src/entities';
import { FILE_MAX_BYTES } from '../src/modules/files/files.dto';
import { canReadStoredFile, decodeBase64, FilesService, fileUrlOf, mimeOf } from '../src/modules/files/files.service';
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

describe('파일 이름에서 MIME — 모르는 확장자는 지어내지 않는다', () => {
  it.each([
    ['계약서.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['영수증.PNG', 'image/png'],
    ['교재.pdf', 'application/pdf'],
    ['무엇.xyz', 'application/octet-stream'],
    ['확장자없음', 'application/octet-stream'],
  ])('%s → %s', (name, mime) => expect(mimeOf(name)).toBe(mime));
});

describe('base64 해독 — data URL 이 붙어 있어도 벗긴다', () => {
  it('접두사가 있든 없든 같은 바이트가 나온다', () => {
    const raw = Buffer.from('타코').toString('base64');
    expect(decodeBase64(raw)?.toString()).toBe('타코');
    expect(decodeBase64(`data:image/png;base64,${raw}`)?.toString()).toBe('타코');
    expect(decodeBase64('  ' + raw + '\n')?.toString()).toBe('타코');
  });
  it('빈 본문과 base64 가 아닌 글자는 null 이다 — 0바이트 행을 만들지 않는다', () => {
    expect(decodeBase64('')).toBeNull();
    expect(decodeBase64('!!!!')).toBeNull();
  });
});

describe('FILE kind별 중앙 권한표', () => {
  const facts = {
    uploadedBy: 10, bookLinked: false, expenseLinked: false, expenseRequester: false,
    reportLinked: false, reportTeacher: false,
  };
  const teacher = { id: 10, name: '강사', role: 'teacher' };
  const manager = { id: 20, name: '매니저', role: 'manager' };
  const ceo = { id: 30, name: '대표', role: 'ceo' };

  it('교재 파일은 실제 판 연결과 관리자 화면·자료 권한을 모두 요구한다', () => {
    expect(canReadStoredFile(manager, 'lib-te', facts)).toBe(false);
    expect(canReadStoredFile(manager, 'lib-te', { ...facts, bookLinked: true })).toBe(true);
    expect(canReadStoredFile({ ...manager, perms: { canGpaPack: false } }, 'lib-te', { ...facts, bookLinked: true })).toBe(false);
    expect(canReadStoredFile({ ...teacher, perms: { canGpaPack: true } }, 'lib-te', { ...facts, bookLinked: true })).toBe(false);
  });

  it('영수증은 연결 원장의 요청자 또는 canMoney만, 컨설팅은 업로더 또는 canHide만 연다', () => {
    expect(canReadStoredFile(teacher, 'expense-receipt', { ...facts, expenseLinked: true, expenseRequester: true })).toBe(true);
    expect(canReadStoredFile(manager, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(false);
    expect(canReadStoredFile(ceo, 'expense-receipt', { ...facts, expenseLinked: true })).toBe(true);
    expect(canReadStoredFile(manager, 'cons-contract', facts)).toBe(false);
    expect(canReadStoredFile(teacher, 'cons-contract', facts)).toBe(false);
    expect(canReadStoredFile({ ...manager, id: 10 }, 'cons-contract', facts)).toBe(true);
    expect(canReadStoredFile(ceo, 'cons-contract', facts)).toBe(true);
  });

  it('리포트는 담당 강사 또는 관리자만 열고, 알 수 없는 kind는 기본 거절한다', () => {
    expect(canReadStoredFile(teacher, 'report-png', { ...facts, uploadedBy: null, reportLinked: true, reportTeacher: true })).toBe(true);
    expect(canReadStoredFile(manager, 'report-png', { ...facts, uploadedBy: null, reportLinked: true })).toBe(true);
    expect(canReadStoredFile(teacher, 'report-png', { ...facts, uploadedBy: null, reportLinked: true })).toBe(false);
    expect(canReadStoredFile(manager, 'future-kind' as never, facts)).toBe(false);
  });
});

d('FILE — 올린 파일이 Neon 안에 그대로 있다 (C48)', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const ME = 71;
  const svc = () => new FilesService(q.manager.getRepository(FileRow));

  beforeAll(async () => { ds = scratchDataSource(); await ds.initialize(); });
  beforeEach(async () => {
    q = ds.createQueryRunner(); await q.connect(); await q.startTransaction();
    await q.query(
      `INSERT INTO staff (id,name,email,role) VALUES ($1,'파일 올린 사람','file71@t.kr','manager')
       ON CONFLICT (id) DO NOTHING`, [ME],
    );
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('올린 본문이 바이트 하나 안 틀리고 돌아온다', async () => {
    const bytes = Buffer.from('민제인 에세이 컨설팅 계약서 초안');
    const ref = await svc().upload(ME, { kind: 'cons-contract', name: '계약서.docx', base64: bytes.toString('base64') });
    expect(ref).toMatchObject({ kind: 'cons-contract', name: '계약서.docx', bytes: bytes.length });
    expect(ref.url).toBe(fileUrlOf(ref.id));

    const back = await svc().read(ref.id);
    expect(back.data.equals(bytes)).toBe(true);
    const [row] = (await q.query(`SELECT sha256, bytes FROM file WHERE id = $1`, [ref.id])) as { sha256: string; bytes: number }[];
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row.bytes).toBe(bytes.length);
  });

  it('클라이언트 MIME은 저장 계약이 아니며 서버가 파일 이름으로 다시 정한다', async () => {
    const ref = await svc().upload(ME, {
      kind: 'lib-se', name: '교재.pdf', base64: Buffer.from('pdf').toString('base64'), mime: 'text/html',
    } as never);
    expect(ref.mime).toBe('application/pdf');
    const [row] = await q.query(`SELECT mime FROM file WHERE id=$1`, [ref.id]);
    expect(row.mime).toBe('application/pdf');
  });

  it('raw 교재 파일은 업로더여도 판에 연결되기 전에는 닫고, 연결 뒤 두 권한을 확인한다', async () => {
    const ref = await svc().upload(ME, { kind: 'lib-te', name: '교사용.pdf', base64: Buffer.from('te').toString('base64') });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    const [lib] = await q.query(`INSERT INTO lib (code,title) VALUES ($1,'raw 파일 교재') RETURNING id`, [`FILE-${ref.id}`]);
    await q.query(`INSERT INTO vers (lib_id,edition,te_file_id) VALUES ($1,'v1',$2)`, [lib.id, ref.id]);
    await expect(svc().readAuthorized({ id: 72, name: '강사', role: 'teacher' }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager', perms: { canGpaPack: false } }, ref.id))
      .rejects.toMatchObject({ response: { code: 'FILE_FORBIDDEN' } });
    await expect(svc().readAuthorized({ id: ME, name: '매니저', role: 'manager' }, ref.id))
      .resolves.toMatchObject({ kind: 'lib-te' });
  });

  it('한도를 넘으면 자르지 않고 거절한다 — 그리고 표도 거절한다', async () => {
    const big = Buffer.alloc(FILE_MAX_BYTES + 1, 7);
    await expect(svc().upload(ME, { kind: 'lib-se', name: '큰교재.pdf', base64: big.toString('base64') }))
      .rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });

    // 서비스를 건너뛰어도 표가 막는다 (원칙 26 · 마지막 방어선)
    await q.query('SAVEPOINT cap');
    await expect(q.query(
      `INSERT INTO file (kind,name,mime,bytes,sha256,data) VALUES ('lib-se','x','application/pdf',$1,repeat('a',64),$2)`,
      [big.length, big],
    )).rejects.toMatchObject({ constraint: 'file_size_cap' });
    await q.query('ROLLBACK TO SAVEPOINT cap');
  });

  it('적어 보낸 길이와 실제 길이가 다르면 표가 거절한다 — 목록·용량이 거짓이 되지 않게', async () => {
    await expect(q.query(
      `INSERT INTO file (kind,name,mime,bytes,sha256,data)
       VALUES ('guide-png','x','image/png',999,repeat('a',64),$1)`,
      [Buffer.from('짧다')],
    )).rejects.toMatchObject({ constraint: 'file_bytes_match' });
  });

  it('빈 본문은 행을 만들지 않는다', async () => {
    await expect(svc().upload(ME, { kind: 'guide-png', name: 'x.png', base64: '' }))
      .rejects.toMatchObject({ response: { code: 'FILE_EMPTY' } });
    const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM file WHERE uploaded_by = $1`, [ME])) as { n: number }[];
    expect(n).toBe(0);
  });

  it('지우면 본문도 같이 사라진다 — 가리키는 행과 같은 트랜잭션에서 지운다', async () => {
    const ref = await svc().upload(ME, { kind: 'expense-receipt', name: '영수증.png', base64: Buffer.from('img').toString('base64') });
    await svc().remove(ref.id);
    await expect(svc().read(ref.id)).rejects.toMatchObject({ response: { code: 'FILE_NOT_FOUND' } });
  });
});
