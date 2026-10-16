/** @file-guide
 * 목적: 만료된 미사용 교재 PDF 업로드의 비공개 Blob과 의도 원장을 정리한다.
 * 책임/재사용: 실제 삭제는 book-pdf.storage의 단건 원자 경계를 사용하며 기본은 건수 조회다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { cleanupOneExpiredBookPdfUpload } from '../src/modules/files/book-pdf.storage';

async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL을 명시해야 합니다');
  }
  const dbName = new URL(raw).pathname.slice(1);
  const run = process.argv.includes('--run');
  if (run && !process.argv.includes(`--database=${dbName}`)) {
    throw new Error(`삭제 실행에는 --run --database=${dbName} 두 인자가 필요합니다`);
  }
  const { default: ds } = await import('../src/data-source');
  await ds.initialize();
  try {
    if (!run) {
      const [row] = await ds.query(
        `SELECT count(*)::int AS n FROM book_pdf_upload u
          WHERE u.expires_at < now() AND u.consumed_file_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM file f WHERE f.blob_path=u.blob_path)`,
      ) as Array<{ n: number }>;
      console.log(`만료된 미사용 교재 PDF 업로드 ${row.n}건 (조회만)`);
      return;
    }
    let removed = 0;
    while (removed < 100 && await ds.transaction((m) => cleanupOneExpiredBookPdfUpload(m))) {
      removed += 1;
    }
    console.log(`만료된 미사용 교재 PDF 업로드 ${removed}건 삭제`);
  } finally {
    await ds.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '정리 실패');
  process.exitCode = 1;
});
