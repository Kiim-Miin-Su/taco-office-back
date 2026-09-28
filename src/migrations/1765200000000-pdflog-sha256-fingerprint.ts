/** @file-guide
 * 목적: 보존한 리포트 PNG 한 장의 SHA-256 을 PDFLOG 에 남겨 같은 requestKey 의 발송 동일성에 바이트를 넣는다 (CR-BE-03).
 * 책임/재사용: 새 행만 채운다 — 옛 행은 NULL(N-25 · 되짚어 해시할 원본이 없다). 값의 모양(소문자 16진 64자)만 CHECK 로 막는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TBO-54 코드 리뷰 CR-BE-03 — 같은 requestKey · revision · fileName 에 **다른 유효 PNG** 를 보내도 요청 동일성에 바이트가 없어
 * 최초 201 로 수렴했다. 발송이 저장하는 장마다 PNG 바이트의 SHA-256 을 함께 적고, 멱등 재시도는 그 값까지 대조한다 —
 * 같은 키 · 같은 바이트는 기존 결과로 수렴하고, 같은 키 · 다른 바이트는 409 `REPORT_DELIVERY_REQUEST_KEY_REUSED` 다.
 * 재발송은 원본 장의 값을 그대로 복사한다(바이트가 같은 파일을 가리킨다).
 */
export class PdflogSha256Fingerprint1765200000000 implements MigrationInterface {
  name = 'PdflogSha256Fingerprint1765200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pdflog" ADD COLUMN "sha256" varchar(64)`);
    await q.query(`ALTER TABLE "pdflog" ADD CONSTRAINT "pdflog_sha256_hex"
      CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "pdflog" WHERE "sha256" IS NOT NULL) THEN
        RAISE EXCEPTION 'PdflogSha256Fingerprint down would discard stored PNG fingerprints';
      END IF;
    END $$`);
    await q.query(`ALTER TABLE "pdflog" DROP CONSTRAINT "pdflog_sha256_hex"`);
    await q.query(`ALTER TABLE "pdflog" DROP COLUMN "sha256"`);
  }
}
