/** @file-guide
 * 목적: report-file.store.ts — REPORT_FILE_STORE, ReportFileStore, VercelReportFileStore (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { del, put } from '@vercel/blob';

export const REPORT_FILE_STORE = Symbol('REPORT_FILE_STORE');

export interface ReportFileStore {
  put(pathname: string, bytes: Buffer): Promise<string>;
  delete(urls: string[]): Promise<void>;
}

/** 외부 파일 저장소 경계. ReportsService는 Vercel SDK와 token 모양을 알지 않는다. */
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
