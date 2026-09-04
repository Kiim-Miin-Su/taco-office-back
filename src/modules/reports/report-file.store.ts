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
