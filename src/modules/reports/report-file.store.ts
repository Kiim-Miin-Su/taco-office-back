/** @file-guide
 * 목적: report-file.store.ts — REPORT_FILE_STORE, ReportFileStore, VercelReportFileStore (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { del, put } from '@vercel/blob';
import { FilesService } from '../files/files.service';

export const REPORT_FILE_STORE = Symbol('REPORT_FILE_STORE');

export interface ReportFileStore {
  put(pathname: string, bytes: Buffer): Promise<string>;
  delete(urls: string[]): Promise<void>;
}

/** 레거시 경계 — 예전에 올라간 주소를 지울 때만 쓴다. ReportsService 는 이 이름을 모른다. */
@Injectable()
export class VercelReportFileStore implements ReportFileStore {
  async put(pathname: string, bytes: Buffer): Promise<string> {
    const blob = await put(pathname, bytes, {
      access: 'private',
      addRandomSuffix: true,
      contentType: 'image/png',
    });
    return blob.url;
  }

  async delete(urls: string[]): Promise<void> {
    if (urls.length > 0) await del(urls);
  }
}

/**
 * **지금 쓰는 저장소** — 올린 파일을 Neon 안에 둔다 (대표 결정 2026-09-12 · D6 · A-D4).
 *
 * 새로 올라가는 리포트 PNG 는 전부 여기로 간다. **예전에 Vercel Blob 으로 올라간 주소는
 * 그대로 둔다** — 어느 저장소인지는 주소 모양으로 갈리고(`/files/{id}` 면 Neon), 지울 때만
 * 예전 주소를 예전 저장소에 넘긴다. 추정해서 옮기지 않는다.
 */
@Injectable()
export class NeonReportFileStore implements ReportFileStore {
  constructor(private readonly files: FilesService, private readonly legacy: VercelReportFileStore) {}

  async put(pathname: string, bytes: Buffer): Promise<string> {
    // 올린 사람은 전달 흐름이 이미 LOG 에 남긴다 — 여기서 다시 추정하지 않는다
    const ref = await this.files.upload(null, {
      kind: 'report-png',
      name: pathname.split('/').pop() || 'report.png',
      base64: bytes.toString('base64'),
      mime: 'image/png',
    });
    return ref.url;
  }

  async delete(urls: string[]): Promise<void> {
    const mine = urls.filter((u) => u.startsWith('/files/'));
    const theirs = urls.filter((u) => !u.startsWith('/files/'));
    for (const u of mine) await this.files.remove(Number(u.slice('/files/'.length)));
    if (theirs.length > 0) await this.legacy.delete(theirs);
  }
}
