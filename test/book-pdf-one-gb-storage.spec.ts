/** @file-guide
 * 목적: 1GB 교재의 업로드 의도·multipart 서명·본문 앞부분 확인·네이티브 다운로드 계약을 DB 없이 검증한다.
 * 책임/재사용: Blob SDK와 EntityManager만 대역으로 두며 실제 저장 함수·DTO·권한 metadata를 실행한다.
 * 검증/작업 지침: test/AGENTS.md · src/modules/files/book-pdf.storage.ts · test/book-pdf-one-gb-db.spec.ts
 */
import { get, getDownloadUrl, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { EntityManager } from 'typeorm';
import { PERM_KEY } from '../src/common/perm/perm.decorator';
import { FilesController } from '../src/modules/files/files.controller';
import {
  BOOK_PDF_EDITION_MAX_BYTES, BOOK_PDF_MAX_BYTES, BookPdfPresignedRequestDto, BookPdfUploadIntentDto,
} from '../src/modules/files/files.dto';
import {
  consumeBookPdfIntent, createBookPdfIntent, createBookPdfPresignedUpload, signedBookPdfDownloadUrl,
} from '../src/modules/files/book-pdf.storage';

jest.mock('@vercel/blob', () => ({
  del: jest.fn(), get: jest.fn(), head: jest.fn(), issueSignedToken: jest.fn(), presignUrl: jest.fn(),
  getDownloadUrl: jest.fn((value: string) => {
    const url = new URL(value);
    url.searchParams.set('download', '1');
    return url.toString();
  }),
}));
jest.mock('@vercel/blob/client', () => ({ handleUploadPresigned: jest.fn() }));

const actorId = 7;
const uploadId = '97430d07-0a20-4b9e-9e93-91d1ed9893be';
const pathname = `books/${actorId}/${uploadId}.pdf`;
const signed = jest.mocked(issueSignedToken);
const presign = jest.mocked(presignUrl);
const sdk = jest.mocked(handleUploadPresigned);
const metadata = jest.mocked(head);
const contents = jest.mocked(get);
const request = { headers: {} } as IncomingMessage;
const payload = (): BookPdfPresignedRequestDto => ({
  type: 'blob.generate-presigned-url', payload: { pathname, clientPayload: uploadId, multipart: true },
});
const intent = () => ({
  actor_id: String(actorId), kind: 'lib-se', original_name: '원본 교재.pdf', expected_bytes: BOOK_PDF_MAX_BYTES,
  blob_path: pathname, expires_at: new Date(Date.now() + 4 * 60 * 60_000), consumed_file_id: null,
});
const manager = (query: jest.Mock): EntityManager => ({ query } as unknown as EntityManager);

describe('1GB private 교재의 DB-free 계약', () => {
  let connection: jest.SpyInstance;
  let fetcher: jest.SpyInstance;

  beforeAll(() => {
    connection = jest.spyOn(Socket.prototype, 'connect').mockImplementation(() => { throw new Error('UNIT_NETWORK_FORBIDDEN'); });
    fetcher = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNIT_FETCH_FORBIDDEN'));
  });
  afterAll(() => { connection.mockRestore(); fetcher.mockRestore(); });
  beforeEach(() => {
    jest.clearAllMocks();
    signed.mockResolvedValue({ delegationToken: 'unit-delegation', clientSigningToken: 'unit-signing', validUntil: Date.now() + 7_200_000 });
    presign.mockResolvedValue({ presignedUrl: 'https://unit.private.example/file.pdf?vercel-blob-signature=unit-signature' });
    sdk.mockImplementation(async (options) => {
      if (options.body.type !== 'blob.generate-presigned-url') {
        throw new Error('UNIT_ISSUANCE_ONLY');
      }
      await options.getSignedToken(options.body.payload.pathname, options.body.payload.clientPayload, options.body.payload.multipart);
      return { type: 'blob.generate-presigned-url', presignedUrlPayload: {
        delegationToken: 'unit-delegation', signature: 'unit-signature', params: { 'vercel-blob-maximum-size': String(BOOK_PDF_MAX_BYTES) },
      } };
    });
  });

  it('DTO는 1GB를 허용하고 초과·잘못된 SDK 본문은 거절한다', async () => {
    expect(BOOK_PDF_EDITION_MAX_BYTES).toBe(2_000_000_000);
    expect(await validate(plainToInstance(BookPdfUploadIntentDto, { kind: 'lib-se', name: '교재.pdf', bytes: 1_000_000_000 }))).toHaveLength(0);
    expect(await validate(plainToInstance(BookPdfUploadIntentDto, { kind: 'lib-se', name: '교재.pdf', bytes: 1_000_000_001 }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(BookPdfPresignedRequestDto, payload()))).toHaveLength(0);
    expect(await validate(plainToInstance(BookPdfPresignedRequestDto, { type: 'blob.generate-presigned-url' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(BookPdfPresignedRequestDto, { ...payload(), type: 'blob.upload-completed' }))).not.toHaveLength(0);
  });

  it('1GB 의도는 메타데이터와 불변 경로만 만들고 1GB+1은 공급자를 부르기 전에 거절한다', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const out = await createBookPdfIntent(manager(query), actorId, { kind: 'lib-se', name: '원본 교재.pdf', bytes: BOOK_PDF_MAX_BYTES });
    expect(out.pathname).toMatch(/^books\/7\/[0-9a-f-]{36}\.pdf$/);
    expect(out.pathname).not.toContain('원본');
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ pathname: out.pathname, operations: ['put'], maximumSizeInBytes: BOOK_PDF_MAX_BYTES }));
    expect(presign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowOverwrite: false, addRandomSuffix: false }));
    signed.mockClear();
    query.mockClear();
    await expect(createBookPdfIntent(manager(query), actorId, { kind: 'lib-se', name: '초과.pdf', bytes: BOOK_PDF_MAX_BYTES + 1 }))
      .rejects.toMatchObject({ response: { code: 'BOOK_PDF_TOO_LARGE' } });
    expect(signed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('multipart는 서버 의도의 정확한 경로·bytes·PDF·PUT 전용·덮어쓰기 금지를 서명한다', async () => {
    const query = jest.fn().mockResolvedValue([intent()]);
    const result = await createBookPdfPresignedUpload(manager(query), actorId, payload(), request, 'unit-public-key');
    expect(result.type).toBe('blob.generate-presigned-url');
    expect(query).toHaveBeenCalledWith(expect.any(String), [uploadId]);
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ pathname, operations: ['put'], allowedContentTypes: ['application/pdf'], maximumSizeInBytes: BOOK_PDF_MAX_BYTES }));
    const options = sdk.mock.calls[0][0];
    const scope = await options.getSignedToken(pathname, uploadId, true);
    expect(scope.urlOptions).toMatchObject({ maximumSizeInBytes: BOOK_PDF_MAX_BYTES, allowOverwrite: false, addRandomSuffix: false });
    expect(scope.urlOptions?.validUntil).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60_000);
    await expect(options.getSignedToken('books/other/file.pdf', uploadId, true)).rejects.toMatchObject({ response: { code: 'BOOK_PDF_UPLOAD_NOT_FOUND' } });
    expect(Reflect.getMetadata(PERM_KEY, FilesController.prototype.bookPdfPresigned)).toEqual(['canAdminPage', 'canCrudAll']);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['다른 소유자', { actor_id: '8' }, 'BOOK_PDF_UPLOAD_NOT_FOUND'],
    ['다른 경로', { blob_path: 'books/7/other.pdf' }, 'BOOK_PDF_UPLOAD_NOT_FOUND'],
    ['만료', { expires_at: new Date(0) }, 'BOOK_PDF_UPLOAD_EXPIRED'],
    ['이미 소비', { consumed_file_id: '23' }, 'BOOK_PDF_UPLOAD_EXPIRED'],
    ['과도한 원장 크기', { expected_bytes: BOOK_PDF_MAX_BYTES + 1 }, 'BOOK_PDF_MISMATCH'],
  ])('%s 의도는 SDK 발급과 공급자 요청을 하지 않는다', async (_label, fields, code) => {
    const query = jest.fn().mockResolvedValue([{ ...intent(), ...fields }]);
    await expect(createBookPdfPresignedUpload(manager(query), actorId, payload(), request, 'unit-public-key'))
      .rejects.toMatchObject({ response: { code } });
    expect(sdk).not.toHaveBeenCalled();
    expect(signed).not.toHaveBeenCalled();
  });

  it('SDK 필수 공개 키가 없으면 안전한 503으로 DB·공급자 요청 전에 멈춘다', async () => {
    const query = jest.fn();
    await expect(createBookPdfPresignedUpload(manager(query), actorId, payload(), request, ''))
      .rejects.toMatchObject({ response: { code: 'BOOK_PDF_MULTIPART_NOT_CONFIGURED' } });
    expect(query).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
    expect(signed).not.toHaveBeenCalled();
  });

  it('1GB 완료 검증은 HEAD와 앞 5bytes만 읽고 stream을 취소한다', async () => {
    const query = jest.fn().mockResolvedValueOnce([intent()]).mockResolvedValueOnce([{ id: '23' }]).mockResolvedValue([]);
    const canceled = jest.fn();
    metadata.mockResolvedValue({ pathname, size: BOOK_PDF_MAX_BYTES, contentType: 'application/pdf' } as never);
    contents.mockResolvedValue({ statusCode: 200, stream: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.7')); }, cancel: canceled,
    }) } as never);
    expect(await consumeBookPdfIntent(manager(query), actorId, uploadId, 'lib-se')).toBe(23);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1][1]).toEqual(['lib-se', '원본 교재.pdf', 'application/pdf', BOOK_PDF_MAX_BYTES, pathname, actorId]);
  });

  it('native attachment URL은 경로·서명을 보존하고 download=1만 추가한다', async () => {
    const result = await signedBookPdfDownloadUrl(pathname);
    const url = new URL(result);
    expect(url.pathname).toBe('/file.pdf');
    expect(url.searchParams.get('vercel-blob-signature')).toBe('unit-signature');
    expect(url.searchParams.get('download')).toBe('1');
    expect([...url.searchParams.keys()].sort()).toEqual(['download', 'vercel-blob-signature']);
    expect(signed).toHaveBeenCalledWith(expect.objectContaining({ pathname, operations: ['get'] }));
    expect(jest.mocked(getDownloadUrl)).toHaveBeenCalledWith(expect.stringContaining('vercel-blob-signature=unit-signature'));
  });
});
