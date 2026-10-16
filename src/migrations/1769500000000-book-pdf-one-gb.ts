/** @file-guide
 * 목적: 비공개 교재 PDF의 FILE·업로드 의도 상한을 50MB에서 파일당 1GB로 확장한다.
 * 책임/재사용: 기존 private PDF migration125와 일반 bytea 3MB 제약을 보존한다. 본문 저장이나 파일 삭제를 수행하지 않는다.
 * 검증/작업 지침: test/book-pdf-one-gb-db.spec.ts · docs/AGENT.md · docs/contracts/FILE-GUIDE.md
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 적용 이력의 상한은 고정 숫자로 남긴다. 현행 DTO 상수를 바꿔 과거 migration을 재작성하지 않는다. */
export class BookPdfOneGigabyte1769500000000 implements MigrationInterface {
  name = 'BookPdfOneGigabyte1769500000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE file DROP CONSTRAINT file_size_cap');
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_size_cap CHECK (
      (blob_path IS NULL AND bytes > 0 AND bytes <= 3000000)
      OR (blob_path IS NOT NULL AND bytes > 0 AND bytes <= 1000000000)
    )`);
    await q.query('ALTER TABLE book_pdf_upload DROP CONSTRAINT book_pdf_upload_expected_bytes_check');
    await q.query(`ALTER TABLE book_pdf_upload ADD CONSTRAINT book_pdf_upload_expected_bytes_check
      CHECK (expected_bytes > 0 AND expected_bytes <= 1000000000)`);
  }

  async down(q: QueryRunner): Promise<void> {
    // 사용자 파일·미소비 의도는 삭제하지 않는다. 큰 행이 있으면 DDL을 시작하기 전에 복구를 거절한다.
    const [row] = (await q.query(`SELECT (
      (SELECT count(*) FROM file WHERE blob_path IS NOT NULL AND bytes > 50000000)
      + (SELECT count(*) FROM book_pdf_upload WHERE expected_bytes > 50000000)
    )::int AS n`)) as Array<{ n: number }>;
    if (row.n > 0) {
      throw new Error('50MB 초과 교재 파일 또는 업로드 의도가 남아 있어 상한을 되돌릴 수 없습니다');
    }
    await q.query('ALTER TABLE file DROP CONSTRAINT file_size_cap');
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_size_cap CHECK (
      (blob_path IS NULL AND bytes > 0 AND bytes <= 3000000)
      OR (blob_path IS NOT NULL AND bytes > 0 AND bytes <= 50000000)
    )`);
    await q.query('ALTER TABLE book_pdf_upload DROP CONSTRAINT book_pdf_upload_expected_bytes_check');
    await q.query(`ALTER TABLE book_pdf_upload ADD CONSTRAINT book_pdf_upload_expected_bytes_check
      CHECK (expected_bytes > 0 AND expected_bytes <= 50000000)`);
  }
}
