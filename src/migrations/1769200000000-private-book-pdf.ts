/** @file-guide
 * 목적: 신규 교재 PDF 업로드 의도와 비공개 Blob 메타데이터를 저장한다.
 * 책임/재사용: 기존 bytea 파일을 그대로 보존하며 저장 형태를 제약한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class PrivateBookPdf1769200000000 implements MigrationInterface {
  name = 'PrivateBookPdf1769200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE file ADD COLUMN blob_path varchar(300)`);
    await q.query(`ALTER TABLE file ALTER COLUMN data DROP NOT NULL`);
    await q.query(`ALTER TABLE file ALTER COLUMN sha256 DROP NOT NULL`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT file_size_cap`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT file_bytes_match`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_size_cap CHECK (
      (blob_path IS NULL AND bytes > 0 AND bytes <= 3000000)
      OR (blob_path IS NOT NULL AND bytes > 0 AND bytes <= 50000000)
    )`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_bytes_match CHECK (blob_path IS NOT NULL OR octet_length(data) = bytes)`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_storage_shape CHECK (
      (blob_path IS NULL AND data IS NOT NULL AND sha256 IS NOT NULL)
      OR (blob_path IS NOT NULL AND data IS NULL AND sha256 IS NULL AND kind IN ('lib-se','lib-te'))
    )`);
    await q.query(`CREATE UNIQUE INDEX file_blob_path_uq ON file (blob_path) WHERE blob_path IS NOT NULL`);
    await q.query(`CREATE TABLE book_pdf_upload (
      id uuid PRIMARY KEY,
      actor_id bigint NOT NULL REFERENCES staff(id),
      kind varchar(6) NOT NULL CHECK (kind IN ('lib-se','lib-te')),
      original_name varchar(200) NOT NULL,
      expected_bytes integer NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 50000000),
      blob_path varchar(300) NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      consumed_file_id bigint UNIQUE REFERENCES file(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX book_pdf_upload_expiry_idx ON book_pdf_upload (expires_at) WHERE consumed_file_id IS NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    const [row] = await q.query(`SELECT count(*)::int AS n FROM file WHERE blob_path IS NOT NULL`) as Array<{ n: number }>;
    if (row.n > 0) throw new Error('Blob 교재 파일이 남아 있어 되돌릴 수 없습니다');
    await q.query(`DROP TABLE book_pdf_upload`);
    await q.query(`DROP INDEX file_blob_path_uq`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT file_storage_shape`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT file_size_cap`);
    await q.query(`ALTER TABLE file DROP CONSTRAINT file_bytes_match`);
    await q.query(`ALTER TABLE file ALTER COLUMN data SET NOT NULL`);
    await q.query(`ALTER TABLE file ALTER COLUMN sha256 SET NOT NULL`);
    await q.query(`ALTER TABLE file DROP COLUMN blob_path`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_size_cap CHECK (bytes > 0 AND bytes <= 3000000)`);
    await q.query(`ALTER TABLE file ADD CONSTRAINT file_bytes_match CHECK (octet_length(data) = bytes)`);
  }
}
