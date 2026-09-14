/** @file-guide
 * 목적: files.service.ts — mimeOf, fileUrlOf, decodeBase64, FilesService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { FileRow } from '../../entities';
import { hasPerm, isRole, type RequestUser } from '../../common/perm';
import { FILE_MAX_BYTES, type FileKind, type FileRefDto, type FileUploadDto } from './files.dto';

/**
 * 확장자로 MIME 을 고른다 — 화면이 보내 준 MIME 을 그대로 믿지 않는다.
 * 모르는 확장자는 `application/octet-stream` 으로 내린다. 없는 형식을 지어내지 않는다.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', hwp: 'application/x-hwp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

export const mimeOf = (name: string): string =>
  MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** 내려받는 자리 — 저장소가 어디인지 **주소 모양으로** 갈린다 (`/files/{id}` = Neon) */
export const fileUrlOf = (id: number): string => `/files/${id}`;

/** base64 본문을 바이트로. data URL 접두사가 붙어 있어도 벗겨 준다 */
export function decodeBase64(raw: string): Buffer | null {
  const body = raw.includes(',') && raw.trimStart().startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const clean = body.replace(/\s+/g, '');
  if (clean === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const bytes = Buffer.from(clean, 'base64');
  return bytes.length > 0 ? bytes : null;
}

export interface PreparedFile {
  bytes: Buffer;
  name: string;
  mime: string;
  sha256: string;
}

/** 파일 본문·이름·서버 MIME·해시를 한 번만 검증해 저장 단계가 재사용한다. */
export function prepareFile(dto: FileUploadDto): PreparedFile {
  const bytes = decodeBase64(dto.base64);
  if (!bytes) throw new BadRequestException({ code: 'FILE_EMPTY', message: '파일 본문이 비어 있거나 base64 가 아닙니다' });
  if (bytes.length > FILE_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: 'FILE_TOO_LARGE',
      message: `파일은 ${FILE_MAX_BYTES / 1_000_000}MB 까지 올릴 수 있습니다 — 이 파일은 ${(bytes.length / 1_000_000).toFixed(1)}MB 입니다`,
    });
  }
  const name = dto.name.trim();
  if (!name) throw new BadRequestException({ code: 'FILE_NAME_REQUIRED', message: '파일 이름이 필요합니다' });
  return {
    bytes,
    name,
    mime: mimeOf(name),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** 검증을 끝낸 파일을 지정 트랜잭션에 저장한다. */
export async function storePreparedFile(
  runner: EntityManager,
  userId: number | null,
  dto: FileUploadDto,
  file: PreparedFile,
): Promise<FileRefDto> {
  const [row] = (await runner.query(
    `INSERT INTO file (kind, name, mime, bytes, sha256, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, to_char(uploaded_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS') || '+09:00' AS at`,
    [dto.kind, file.name, file.mime, file.bytes.length, file.sha256, file.bytes, userId],
  )) as Array<{ id: string; at: string }>;
  return {
    id: Number(row.id), kind: dto.kind, name: file.name, mime: file.mime,
    bytes: file.bytes.length, url: fileUrlOf(Number(row.id)), uploaderName: null, uploadedAt: row.at,
  };
}

/**
 * FILE 한 건을 저장하는 공용 원자 연산.
 *
 * 독립 업로드는 repository manager로, 다른 업무 쓰기(교재 판 등)는 그 업무의
 * EntityManager로 호출한다. 이렇게 해야 파일과 업무 레코드가 한 트랜잭션에서
 * 함께 성공하거나 함께 되돌아가며, 크기/MIME/해시 방어도 한 곳만 유지된다.
 */
export async function storeFile(
  runner: EntityManager,
  userId: number | null,
  dto: FileUploadDto,
): Promise<FileRefDto> {
  return storePreparedFile(runner, userId, dto, prepareFile(dto));
}

interface FileAccessFacts {
  uploadedBy: number | null;
  bookLinked: boolean;
  expenseLinked: boolean;
  expenseRequester: boolean;
  reportLinked: boolean;
  reportTeacher: boolean;
}

/** raw FILE id의 단일 권한표. 새 kind는 명시적으로 추가하기 전까지 거절한다. */
export function canReadStoredFile(user: RequestUser, kind: FileKind, facts: FileAccessFacts): boolean {
  if (!isRole(user.role)) return false;
  const mine = facts.uploadedBy === user.id;
  switch (kind) {
    case 'lib-se':
    case 'lib-te':
      return facts.bookLinked
        && hasPerm(user.role, 'canAdminPage', user.perms)
        && hasPerm(user.role, 'canGpaPack', user.perms);
    case 'expense-receipt':
      return facts.expenseLinked
        && (hasPerm(user.role, 'canMoney', user.perms) || facts.expenseRequester);
    case 'cons-contract':
    case 'cons-item':
      return hasPerm(user.role, 'canAdminPage', user.perms)
        && (mine || hasPerm(user.role, 'canHide', user.perms));
    case 'report-png':
      return mine || facts.reportTeacher
        || facts.reportLinked && hasPerm(user.role, 'canAdminPage', user.perms);
    case 'guide-png':
    case 'meet-brief':
      return mine || hasPerm(user.role, 'canAdminPage', user.perms);
    default:
      return false;
  }
}

@Injectable()
export class FilesService {
  constructor(@InjectRepository(FileRow) private readonly files: Repository<FileRow>) {}

  /**
   * 올린다. **한도는 표가 지키고**(CHECK `file_size_cap`) 여기서는 먼저 알아듣게 거절한다 —
   * 두 층을 다 둔다(원칙 26). 길이는 우리가 다시 센다: 화면이 보낸 숫자를 믿지 않는다.
   */
  async upload(userId: number | null, dto: FileUploadDto, m?: EntityManager): Promise<FileRefDto> {
    return storeFile(m ?? this.files.manager, userId, dto);
  }

  /** 본문을 꺼낸다 — 내부 도메인 service가 이미 권한을 판정한 뒤 쓰는 경로다. */
  async read(id: number): Promise<{ kind: FileKind; name: string; mime: string; data: Buffer }> {
    const [row] = (await this.files.query(
      `SELECT kind, name, mime, data FROM file WHERE id = $1`, [id],
    )) as Array<{ kind: FileKind; name: string; mime: string; data: Buffer }>;
    if (!row) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다' });
    return row;
  }

  /** raw 바이트 경계. 순차 id를 넣어도 종류와 실제 연결 원장을 모두 통과해야 한다. */
  async readAuthorized(user: RequestUser, id: number): Promise<{ kind: FileKind; name: string; mime: string; data: Buffer }> {
    const [row] = (await this.files.query(
      `SELECT f.kind,f.uploaded_by,
              EXISTS (SELECT 1 FROM vers v WHERE v.se_file_id=f.id OR v.te_file_id=f.id OR v.file_url=$2) AS book_linked,
              EXISTS (SELECT 1 FROM expense e WHERE e.receipt_url=$2) AS expense_linked,
              EXISTS (SELECT 1 FROM expense e WHERE e.receipt_url=$2 AND e.requester_id=$3) AS expense_requester,
              EXISTS (SELECT 1 FROM pdflog p WHERE p.kind='report_png' AND p.file_url=$2) AS report_linked,
              EXISTS (
                SELECT 1 FROM pdflog p JOIN rep r ON r.id=p.ref_id
                 WHERE p.kind='report_png' AND p.file_url=$2 AND r.teacher_id=$3
              ) AS report_teacher
         FROM file f WHERE f.id=$1`,
      [id, fileUrlOf(id), user.id],
    )) as Array<{
      kind: FileKind; uploaded_by: string | null; book_linked: boolean; expense_linked: boolean;
      expense_requester: boolean; report_linked: boolean; report_teacher: boolean;
    }>;
    if (!row) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다' });
    if (!canReadStoredFile(user, row.kind, {
      uploadedBy: row.uploaded_by == null ? null : Number(row.uploaded_by),
      bookLinked: row.book_linked,
      expenseLinked: row.expense_linked,
      expenseRequester: row.expense_requester,
      reportLinked: row.report_linked,
      reportTeacher: row.report_teacher,
    })) {
      throw new ForbiddenException({ code: 'FILE_FORBIDDEN', message: '이 파일을 열 권한이 없습니다' });
    }
    return this.read(id);
  }

  /** 가리키는 행이 사라질 때 함께 지운다 — 같은 트랜잭션에서 부른다 */
  async remove(id: number, m?: EntityManager): Promise<void> {
    await (m ?? this.files.manager).query(`DELETE FROM file WHERE id = $1`, [id]);
  }
}
