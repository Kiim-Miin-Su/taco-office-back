/** @file-guide
 * 목적: 비공개 교재 PDF의 업로드 의도·완료 검증·짧은 다운로드 서명을 격리 DB에서 검증한다.
 * 책임/재사용: Blob SDK 네트워크만 가짜로 두고 실제 migration 제약과 서비스 함수를 실행한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { del, get, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { cleanupOneExpiredBookPdfUpload, createBookPdfIntent, consumeBookPdfIntent, signedBookPdfDownloadUrl } from '../src/modules/files/book-pdf.storage';
import { assertScratch, TEST_URL } from './db';

jest.mock('@vercel/blob', () => ({
  del: jest.fn(), get: jest.fn(), head: jest.fn(), issueSignedToken: jest.fn(), presignUrl: jest.fn(),
  getDownloadUrl: (value: string) => {
    const url = new URL(value);
    url.searchParams.set('download', '1');
    return url.toString();
  },
}));
jest.mock('@vercel/blob/client', () => ({ handleUploadPresigned: jest.fn() }));

const d = TEST_URL ? describe : describe.skip;
const signed = jest.mocked(issueSignedToken);
const presign = jest.mocked(presignUrl);
const metadata = jest.mocked(head);
const contents = jest.mocked(get);
const remove = jest.mocked(del);

d('비공개 교재 PDF 업로드 원장', () => {
  let ds: DataSource;
  let q: QueryRunner;
  const actor = 72901;

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url: assertScratch(TEST_URL), ssl: false, logging: false });
    await ds.initialize();
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    signed.mockResolvedValue({ delegationToken: 'server-only', clientSigningToken: 'server-only', validUntil: Date.now() + 600_000 });
    presign.mockResolvedValue({ presignedUrl: 'https://blob.example/private-signed' });
    remove.mockResolvedValue(undefined);
    contents.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.7')); controller.close(); } }),
    } as never);
    q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    await q.query(`INSERT INTO staff(id,name,email,role) VALUES ($1,'PDF 관리자','pdf72901@test.invalid','admin') ON CONFLICT(id) DO NOTHING`, [actor]);
  });
  afterEach(async () => {
    if (q?.isTransactionActive) await q.rollbackTransaction();
    if (q && !q.isReleased) await q.release();
  });
  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  it('서버 생성 경로 한 개에만 private PDF PUT을 허용하고 의도를 저장한다', async () => {
    const out = await createBookPdfIntent(q.manager, actor, { kind: 'lib-se', name: '실제 교재.pdf', bytes: 5 });
    const [row] = await q.query(`SELECT actor_id,kind,original_name,expected_bytes,blob_path,consumed_file_id FROM book_pdf_upload WHERE id=$1`, [out.uploadId]);
    expect(row).toMatchObject({ kind: 'lib-se', original_name: '실제 교재.pdf', expected_bytes: 5, consumed_file_id: null });
    expect(row.blob_path).toMatch(/^books\/72901\/[0-9a-f-]{36}\.pdf$/);
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ pathname: row.blob_path, operations: ['put'], allowedContentTypes: ['application/pdf'], maximumSizeInBytes: 5 }));
    expect(presign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ access: 'private', pathname: row.blob_path, allowOverwrite: false }));
    expect(out.uploadUrl).toBe('https://blob.example/private-signed');
  });

  it('올린 바이트 수·MIME·경로를 확인한 뒤 메타데이터를 만들며 재사용을 거절한다', async () => {
    const out = await createBookPdfIntent(q.manager, actor, { kind: 'lib-te', name: '교사용.pdf', bytes: 5 });
    const [intent] = await q.query(`SELECT blob_path FROM book_pdf_upload WHERE id=$1`, [out.uploadId]);
    metadata.mockResolvedValue({ pathname: intent.blob_path, size: 5, contentType: 'application/pdf' } as never);
    await expect(consumeBookPdfIntent(q.manager, actor + 1, out.uploadId, 'lib-te')).rejects.toMatchObject({ response: { code: 'BOOK_PDF_UPLOAD_NOT_FOUND' } });
    await expect(consumeBookPdfIntent(q.manager, actor, out.uploadId, 'lib-se')).rejects.toMatchObject({ response: { code: 'BOOK_PDF_UPLOAD_NOT_FOUND' } });
    metadata.mockResolvedValueOnce({ pathname: intent.blob_path, size: 4, contentType: 'application/pdf' } as never);
    await expect(consumeBookPdfIntent(q.manager, actor, out.uploadId, 'lib-te')).rejects.toMatchObject({ response: { code: 'BOOK_PDF_MISMATCH' } });
    contents.mockResolvedValueOnce({
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('wrong')); controller.close(); } }),
    } as never);
    await expect(consumeBookPdfIntent(q.manager, actor, out.uploadId, 'lib-te')).rejects.toMatchObject({ response: { code: 'BOOK_PDF_CONTENT_INVALID' } });
    const id = await consumeBookPdfIntent(q.manager, actor, out.uploadId, 'lib-te');
    const [file] = await q.query(`SELECT kind,name,mime,bytes,sha256,data,blob_path FROM file WHERE id=$1`, [id]);
    expect(file).toMatchObject({ kind: 'lib-te', name: '교사용.pdf', mime: 'application/pdf', bytes: 5, sha256: null, data: null, blob_path: intent.blob_path });
    await expect(consumeBookPdfIntent(q.manager, actor, out.uploadId, 'lib-te')).rejects.toMatchObject({ response: { code: 'BOOK_PDF_UPLOAD_EXPIRED' } });
    await q.query(`DELETE FROM file WHERE id=$1`, [id]);
    const [remaining] = await q.query(`SELECT count(*)::int AS n FROM book_pdf_upload WHERE id=$1`, [out.uploadId]);
    expect(remaining.n).toBe(0);
  });

  it('권한을 통과한 정확한 경로에만 짧은 private GET을 서명한다', async () => {
    const url = await signedBookPdfDownloadUrl('books/72901/example.pdf');
    expect(url).toBe('https://blob.example/private-signed?download=1');
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ pathname: 'books/72901/example.pdf', operations: ['get'] }));
    expect(presign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'get', access: 'private', pathname: 'books/72901/example.pdf' }));
  });

  it('만료된 미사용 객체만 지우고 삭제 실패 시 원장을 남긴다', async () => {
    const out = await createBookPdfIntent(q.manager, actor, { kind: 'lib-se', name: '미사용.pdf', bytes: 5 });
    const [intent] = await q.query(`SELECT blob_path FROM book_pdf_upload WHERE id=$1`, [out.uploadId]);
    await q.query(`UPDATE book_pdf_upload SET expires_at=now()-interval '1 second' WHERE id=$1`, [out.uploadId]);
    remove.mockRejectedValueOnce(new Error('Blob unavailable'));
    await expect(cleanupOneExpiredBookPdfUpload(q.manager)).rejects.toThrow('Blob unavailable');
    expect((await q.query(`SELECT id FROM book_pdf_upload WHERE id=$1`, [out.uploadId])).length).toBe(1);
    expect(await cleanupOneExpiredBookPdfUpload(q.manager)).toBe(true);
    expect(remove).toHaveBeenLastCalledWith(intent.blob_path);
    expect((await q.query(`SELECT id FROM book_pdf_upload WHERE id=$1`, [out.uploadId])).length).toBe(0);
  });
});
