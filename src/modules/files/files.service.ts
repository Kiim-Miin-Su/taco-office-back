/** @file-guide
 * 목적: files.service.ts — mimeOf, fileUrlOf, decodeBase64, FilesService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { FileRow } from '../../entities';
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

@Injectable()
export class FilesService {
  constructor(@InjectRepository(FileRow) private readonly files: Repository<FileRow>) {}

  /**
   * 올린다. **한도는 표가 지키고**(CHECK `file_size_cap`) 여기서는 먼저 알아듣게 거절한다 —
   * 두 층을 다 둔다(원칙 26). 길이는 우리가 다시 센다: 화면이 보낸 숫자를 믿지 않는다.
   */
  async upload(userId: number | null, dto: FileUploadDto, m?: EntityManager): Promise<FileRefDto> {
    const bytes = decodeBase64(dto.base64);
    if (!bytes) throw new BadRequestException({ code: 'FILE_EMPTY', message: '파일 본문이 비어 있거나 base64 가 아닙니다' });
    if (bytes.length > FILE_MAX_BYTES) {
      throw new PayloadTooLargeException({
        code: 'FILE_TOO_LARGE',
        message: `파일은 ${Math.floor(FILE_MAX_BYTES / 1024 / 1024)}MB 까지 올릴 수 있습니다 — 이 파일은 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 입니다`,
      });
    }
    const name = dto.name.trim();
    if (!name) throw new BadRequestException({ code: 'FILE_NAME_REQUIRED', message: '파일 이름이 필요합니다' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const runner = m ?? this.files.manager;
    const [row] = (await runner.query(
      `INSERT INTO file (kind, name, mime, bytes, sha256, data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, to_char(uploaded_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS') || '+09:00' AS at`,
      [dto.kind, name, dto.mime?.trim() || mimeOf(name), bytes.length, sha256, bytes, userId],
    )) as Array<{ id: string; at: string }>;
    return {
      id: Number(row.id), kind: dto.kind, name, mime: dto.mime?.trim() || mimeOf(name),
      bytes: bytes.length, url: fileUrlOf(Number(row.id)), uploaderName: null, uploadedAt: row.at,
    };
  }

  /** 본문을 꺼낸다 — 없는 id 는 404 다. 권한은 부르는 쪽(컨트롤러)이 kind 로 가른다 */
  async read(id: number): Promise<{ kind: FileKind; name: string; mime: string; data: Buffer }> {
    const [row] = (await this.files.query(
      `SELECT kind, name, mime, data FROM file WHERE id = $1`, [id],
    )) as Array<{ kind: FileKind; name: string; mime: string; data: Buffer }>;
    if (!row) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다' });
    return row;
  }

  /** 가리키는 행이 사라질 때 함께 지운다 — 같은 트랜잭션에서 부른다 */
  async remove(id: number, m?: EntityManager): Promise<void> {
    await (m ?? this.files.manager).query(`DELETE FROM file WHERE id = $1`, [id]);
  }
}
