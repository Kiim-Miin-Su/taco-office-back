/** @file-guide
 * 목적: 신규 교재 PDF의 비공개 Blob 업로드 의도·완료 검증·다운로드 서명을 소유한다.
 * 책임/재사용: FILE 권한은 FilesService에서, 판 연결은 BooksService에서 검사한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { del, get, getDownloadUrl, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { EntityManager } from 'typeorm';
import {
  BOOK_PDF_MAX_BYTES, type BookPdfPresignedRequestDto, type BookPdfPresignedResultDto,
  type BookPdfUploadIntentDto, type BookPdfUploadUrlDto,
} from './files.dto';

const PDF_MIME = 'application/pdf';
const UPLOAD_URL_MS = 2 * 60 * 60_000;

/** 서버가 만든 정확한 경로 하나만 PUT 가능하며 원본 이름은 Blob 경로에 포함하지 않는다. */
export async function createBookPdfIntent(m: EntityManager, actorId: number, dto: BookPdfUploadIntentDto): Promise<BookPdfUploadUrlDto> {
  const name = dto.name.trim();
  if (!name || !name.toLowerCase().endsWith('.pdf')) {
    throw new BadRequestException({ code: 'BOOK_PDF_REQUIRED', message: 'PDF 파일을 선택해 주세요' });
  }
  if (dto.bytes > BOOK_PDF_MAX_BYTES) {
    throw new PayloadTooLargeException({ code: 'BOOK_PDF_TOO_LARGE', message: '교재 PDF는 파일당 1GB까지 올릴 수 있습니다' });
  }
  const uploadId = randomUUID();
  const pathname = `books/${actorId}/${uploadId}.pdf`;
  const validUntil = Date.now() + UPLOAD_URL_MS;
  const signed = await issueSignedToken({ pathname, operations: ['put'], validUntil, allowedContentTypes: [PDF_MIME], maximumSizeInBytes: dto.bytes });
  const { presignedUrl } = await presignUrl(signed, {
    operation: 'put', access: 'private', pathname, validUntil,
    allowedContentTypes: [PDF_MIME], maximumSizeInBytes: dto.bytes,
    allowOverwrite: false, addRandomSuffix: false,
  });
  await m.query(
    `INSERT INTO book_pdf_upload (id, actor_id, kind, original_name, expected_bytes, blob_path, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '4 hours')`,
    [uploadId, actorId, dto.kind, name, dto.bytes, pathname],
  );
  return { uploadId, pathname, uploadUrl: presignedUrl };
}

/**
 * 정식 SDK의 multipart 발급 경계. 요청 pathname·bytes를 다시 신뢰하지 않고 기존 의도로 범위를 제한한다.
 * 완료 callback으로 판을 저장하지 않는다. 기존 consume 경로의 HEAD·PDF 서명 검증과 DB transaction을 유지한다.
 */
export async function createBookPdfPresignedUpload(
  m: EntityManager,
  actorId: number,
  dto: BookPdfPresignedRequestDto,
  request: IncomingMessage,
  webhookPublicKey = process.env.BLOB_WEBHOOK_PUBLIC_KEY,
): Promise<BookPdfPresignedResultDto> {
  // SDK 2.8.0은 발급만 해도 이 공개 키를 요구한다. 누락을 공급자 요청이나 내부 stack으로 노출하지 않는다.
  if (!webhookPublicKey?.trim()) {
    throw new ServiceUnavailableException({ code: 'BOOK_PDF_MULTIPART_NOT_CONFIGURED', message: 'PDF 대용량 업로드 설정을 확인해 주세요' });
  }
  const [intent] = (await m.query(
    `SELECT actor_id, expected_bytes, blob_path, expires_at, consumed_file_id FROM book_pdf_upload WHERE id=$1`,
    [dto.payload.clientPayload],
  )) as Array<{ actor_id: string; expected_bytes: number; blob_path: string; expires_at: Date; consumed_file_id: string | null }>;
  if (!intent || Number(intent.actor_id) !== actorId || intent.blob_path !== dto.payload.pathname) {
    throw new NotFoundException({ code: 'BOOK_PDF_UPLOAD_NOT_FOUND', message: '이 업로드를 찾을 수 없습니다' });
  }
  const expiresAt = new Date(intent.expires_at).getTime();
  if (intent.consumed_file_id || expiresAt <= Date.now()) {
    throw new ConflictException({ code: 'BOOK_PDF_UPLOAD_EXPIRED', message: '업로드가 만료됐거나 이미 사용됐습니다' });
  }
  if (!Number.isSafeInteger(intent.expected_bytes) || intent.expected_bytes < 1 || intent.expected_bytes > BOOK_PDF_MAX_BYTES) {
    throw new BadRequestException({ code: 'BOOK_PDF_MISMATCH', message: 'PDF 업로드 의도의 크기가 유효하지 않습니다' });
  }
  const validUntil = Math.min(Date.now() + UPLOAD_URL_MS, expiresAt);
  const result = await handleUploadPresigned({
    request, body: dto, webhookPublicKey,
    getSignedToken: async (pathname, clientPayload) => {
      if (pathname !== intent.blob_path || clientPayload !== dto.payload.clientPayload) {
        throw new NotFoundException({ code: 'BOOK_PDF_UPLOAD_NOT_FOUND', message: '이 업로드를 찾을 수 없습니다' });
      }
      const token = await issueSignedToken({
        pathname: intent.blob_path, operations: ['put'], validUntil,
        allowedContentTypes: [PDF_MIME], maximumSizeInBytes: intent.expected_bytes,
      });
      return { token, urlOptions: {
        validUntil, allowedContentTypes: [PDF_MIME], maximumSizeInBytes: intent.expected_bytes,
        allowOverwrite: false, addRandomSuffix: false,
      } };
    },
  });
  if (result.type !== 'blob.generate-presigned-url') {
    throw new BadRequestException({ code: 'BOOK_PDF_UPLOAD_REQUEST_INVALID', message: 'PDF 업로드 발급 요청이 아닙니다' });
  }
  return result;
}

/** 완료된 업로드만 판 트랜잭션 안에서 파일 ID로 바꾼다. 실패하면 의도가 남아 재시도할 수 있다. */
export async function consumeBookPdfIntent(
  m: EntityManager, actorId: number, uploadId: string, expectedKind: 'lib-se' | 'lib-te',
): Promise<number> {
  const [intent] = await m.query(
    `SELECT actor_id, kind, original_name, expected_bytes, blob_path, expires_at, consumed_file_id
       FROM book_pdf_upload WHERE id=$1 FOR UPDATE`, [uploadId],
  ) as Array<{ actor_id: string; kind: string; original_name: string; expected_bytes: number; blob_path: string; expires_at: Date; consumed_file_id: string | null }>;
  if (!intent || Number(intent.actor_id) !== actorId || intent.kind !== expectedKind) {
    throw new NotFoundException({ code: 'BOOK_PDF_UPLOAD_NOT_FOUND', message: '이 업로드를 찾을 수 없습니다' });
  }
  if (intent.consumed_file_id || new Date(intent.expires_at).getTime() < Date.now()) {
    throw new ConflictException({ code: 'BOOK_PDF_UPLOAD_EXPIRED', message: '업로드가 만료됐거나 이미 사용됐습니다' });
  }
  let blob: Awaited<ReturnType<typeof head>>;
  const abort = AbortSignal.timeout(8_000);
  try {
    blob = await head(intent.blob_path, { abortSignal: abort });
  } catch {
    throw new ConflictException({ code: 'BOOK_PDF_UPLOAD_INCOMPLETE', message: 'PDF 업로드가 완료되지 않았습니다' });
  }
  if (blob.pathname !== intent.blob_path || blob.size !== intent.expected_bytes || blob.contentType !== PDF_MIME) {
    throw new BadRequestException({ code: 'BOOK_PDF_MISMATCH', message: '올린 PDF의 크기 또는 형식이 요청과 다릅니다' });
  }
  // 확장자·Content-Type은 올리는 쪽이 고를 수 있으므로 비공개 본문의 PDF 서명도 확인한다.
  let prefix: Uint8Array;
  try {
    const object = await get(intent.blob_path, { access: 'private', useCache: false, abortSignal: abort });
    if (!object || object.statusCode !== 200) {
      throw new Error('body unavailable');
    }
    const reader = object.stream.getReader();
    const chunks: number[] = [];
    try {
      while (chunks.length < 5) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        chunks.push(...next.value.subarray(0, 5 - chunks.length));
      }
    } finally {
      await reader.cancel();
    }
    prefix = Uint8Array.from(chunks);
  } catch {
    throw new ConflictException({ code: 'BOOK_PDF_UPLOAD_INCOMPLETE', message: 'PDF 본문을 확인하지 못했습니다' });
  }
  if (Buffer.from(prefix).toString('ascii') !== '%PDF-') {
    throw new BadRequestException({ code: 'BOOK_PDF_CONTENT_INVALID', message: 'PDF 파일 형식이 아닙니다' });
  }
  const [file] = await m.query(
    `INSERT INTO file (kind, name, mime, bytes, sha256, data, blob_path, uploaded_by)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6) RETURNING id`,
    [expectedKind, intent.original_name, PDF_MIME, blob.size, intent.blob_path, actorId],
  ) as Array<{ id: string }>;
  await m.query(`UPDATE book_pdf_upload SET consumed_file_id=$2 WHERE id=$1`, [uploadId, file.id]);
  return Number(file.id);
}

/** 다운로드 시점에 ACL 통과 후 FILE에 저장된 정확한 경로만 짧게 서명한다. */
export async function signedBookPdfDownloadUrl(pathname: string): Promise<string> {
  const validUntil = Date.now() + 2 * 60_000;
  const signed = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(signed, { operation: 'get', access: 'private', pathname, validUntil });
  // 네이티브 다운로드가 본문 전체를 JS Blob으로 복사하지 않도록 attachment URL을 돌려준다.
  return getDownloadUrl(presignedUrl);
}

/** 만료된 미사용 업로드 한 건만 지운다. Blob 삭제 실패 시 원장을 남겨 다음 실행에서 재시도한다. */
export async function cleanupOneExpiredBookPdfUpload(m: EntityManager): Promise<boolean> {
  const [row] = await m.query(
    `SELECT u.id, u.blob_path FROM book_pdf_upload u
      WHERE u.expires_at < now() AND u.consumed_file_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM file f WHERE f.blob_path=u.blob_path)
      ORDER BY u.expires_at LIMIT 1 FOR UPDATE OF u SKIP LOCKED`,
  ) as Array<{ id: string; blob_path: string }>;
  if (!row) {
    return false;
  }
  await del(row.blob_path);
  await m.query(`DELETE FROM book_pdf_upload WHERE id=$1`, [row.id]);
  return true;
}
