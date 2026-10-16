/** @file-guide
 * 목적: 전진126의 1GB 메타데이터·1GB 초과 거절·기존 bytea 한도·데이터 보존 복구를 격리 PostgreSQL에서 검증한다.
 * 책임/재사용: 실제 migration·CHECK를 실행한다. 외부 Blob 본문과 공급자 연결은 사용하지 않는다.
 * 검증/작업 지침: test/AGENTS.md. 승인한 localhost:55486/taco_book_pdf_1gb_test에서만 실행한다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { BookPdfOneGigabyte1769500000000 } from '../src/migrations/1769500000000-book-pdf-one-gb';

// 원본 환경 파일을 읽지 않는다. DB 접속은 승인한 명시적 shell 변수만 사용한다.
jest.mock('dotenv', () => ({ config: jest.fn() }));
const target = process.env.TEST_DATABASE_URL;
const d = target ? describe : describe.skip;
const actor = 95101;
const migration = new BookPdfOneGigabyte1769500000000();

function scratchTarget(raw: string): string {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55486' || url.pathname !== '/taco_book_pdf_1gb_test') {
    throw new Error('1GB 교재 DB 검증은 승인한 localhost:55486/taco_book_pdf_1gb_test에서만 실행합니다');
  }
  return raw;
}

d('교재 1GB 전진126 실제 DB 제약', () => {
  let ds: DataSource;
  let q: QueryRunner;

  beforeAll(async () => {
    const { dataSourceOptions } = await import('../src/data-source');
    if (!target || dataSourceOptions.type !== 'postgres') {
      throw new Error('명시적 격리 PostgreSQL이 필요합니다');
    }
    ds = new DataSource({ ...dataSourceOptions, url: scratchTarget(target), ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await migration.down(q);
    await q.query(`INSERT INTO staff(id,name,email,login_id,role,active)
      VALUES ($1,'1GB 격리 검수','book-pdf-1gb@example.invalid','qa-book-pdf-1gb','ceo',true)`, [actor]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) {
      await q.rollbackTransaction();
    }
    if (q && !q.isReleased) {
      await q.release();
    }
  });
  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  async function blobFile(bytes: number): Promise<number> {
    const [row] = (await q.query(`INSERT INTO file(kind,name,mime,bytes,sha256,data,blob_path,uploaded_by)
      VALUES ('lib-se','격리 교재.pdf','application/pdf',$1,NULL,NULL,$2,$3) RETURNING id`,
    [bytes, `books/${actor}/${randomUUID()}.pdf`, actor])) as Array<{ id: string }>;
    return Number(row.id);
  }
  async function uploadIntent(bytes: number): Promise<string> {
    const id = randomUUID();
    await q.query(`INSERT INTO book_pdf_upload(id,actor_id,kind,original_name,expected_bytes,blob_path,expires_at)
      VALUES ($1,$2,'lib-se','격리 교재.pdf',$3,$4,now()+interval '4 hours')`,
    [id, actor, bytes, `books/${actor}/${id}.pdf`]);
    return id;
  }
  async function checkRejected(write: () => Promise<unknown>, constraint: string): Promise<void> {
    await q.query('SAVEPOINT expected_rejection');
    await expect(write()).rejects.toMatchObject({ code: '23514', constraint });
    await q.query('ROLLBACK TO SAVEPOINT expected_rejection');
  }

  it('125의 50MB에서 전진126 후 1GB FILE·의도 메타데이터를 저장한다', async () => {
    await checkRejected(() => blobFile(50_000_001), 'file_size_cap');
    await migration.up(q);
    const fileId = await blobFile(1_000_000_000);
    const intentId = await uploadIntent(1_000_000_000);
    const [file] = await q.query('SELECT bytes,data,sha256,blob_path FROM file WHERE id=$1', [fileId]);
    expect(file).toMatchObject({ bytes: 1_000_000_000, data: null, sha256: null });
    const [intent] = await q.query('SELECT expected_bytes FROM book_pdf_upload WHERE id=$1', [intentId]);
    expect(intent.expected_bytes).toBe(1_000_000_000);
  });

  it('1GB+1은 FILE와 의도 모두 CHECK로 거절한다', async () => {
    await migration.up(q);
    await checkRejected(() => blobFile(1_000_000_001), 'file_size_cap');
    await checkRejected(() => uploadIntent(1_000_000_001), 'book_pdf_upload_expected_bytes_check');
  });

  it('일반 bytea는 원래의 3MB를 보존하며 3MB+1을 거절한다', async () => {
    await migration.up(q);
    const write = (bytes: Buffer) => q.query(`INSERT INTO file(kind,name,mime,bytes,sha256,data,uploaded_by)
      VALUES ('cons-item','격리 자료.bin','application/octet-stream',$1,$2,$3,$4) RETURNING octet_length(data) AS size`,
    [bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes, actor]);
    const rows = await write(Buffer.alloc(3_000_000));
    expect(rows[0].size).toBe(3_000_000);
    await checkRejected(() => write(Buffer.alloc(3_000_001)), 'file_size_cap');
  });

  it('50MB 초과 FILE이 있으면 down을 거절하고 행을 보존한다', async () => {
    await migration.up(q);
    const id = await blobFile(50_000_001);
    await expect(migration.down(q)).rejects.toThrow('50MB 초과 교재 파일 또는 업로드 의도');
    expect((await q.query('SELECT bytes FROM file WHERE id=$1', [id]))[0].bytes).toBe(50_000_001);
    // 전용 fixture만 지운 뒤 복구와 재적용이 실제로 가능한지 대조한다.
    await q.query('DELETE FROM file WHERE id=$1 AND uploaded_by=$2', [id, actor]);
    await migration.down(q);
    await checkRejected(() => blobFile(50_000_001), 'file_size_cap');
    await migration.up(q);
    await blobFile(1_000_000_000);
  });

  it('50MB 초과 미소비 의도가 있어도 down을 거절하고 보존한다', async () => {
    await migration.up(q);
    const id = await uploadIntent(50_000_001);
    await expect(migration.down(q)).rejects.toThrow('50MB 초과 교재 파일 또는 업로드 의도');
    expect((await q.query('SELECT expected_bytes FROM book_pdf_upload WHERE id=$1', [id]))[0].expected_bytes).toBe(50_000_001);
    await q.query('DELETE FROM book_pdf_upload WHERE id=$1 AND actor_id=$2', [id, actor]);
    await migration.down(q);
    await checkRejected(() => uploadIntent(50_000_001), 'book_pdf_upload_expected_bytes_check');
  });
});
