/** @file-guide
 * 목적: 1758800000000-file-store.ts — FileStore1758800000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FILE — 올린 파일을 **Neon 안에** 둔다 (대표 결정 2026-09-12: 「파일 저장소는 Neon에 올릴 수 있으면 올리기」).
 *
 * 이 결정이 D6(교재·자료 파일 저장소)와 A-D4(증빙 보관)를 함께 닫는다. 예전 기록은
 * 「확정 스택 Vercel Blob」이었는데 대표 지시로 바뀌었다 — 저장소가 하나여야 보존·열람 규칙도 하나다.
 *
 * 왜 표에 넣나
 *   · 파일과 그 파일을 가리키는 행이 **같은 트랜잭션**에서 함께 커밋된다. 외부 저장소면
 *     파일은 올라갔는데 행은 롤백되는(또는 그 반대) 반쪽 상태가 생긴다.
 *   · 백업·복구·보존 기간이 DB 하나로 끝난다 (A-D4 5년).
 *
 * 크기 한도 — **8MiB**. 「올릴 수 있으면」의 경계를 표가 지킨다.
 *   더 큰 파일은 조용히 자르지 않고 **거절한다**. 업로드는 JSON(base64)으로 오므로
 *   8MiB 는 요청 본문 약 11MiB 다. 이보다 큰 자료(수백 쪽 교재 원본 등)는 대표가
 *   외부 저장소를 쓸지 따로 정한다 — 지금 지어내지 않는다.
 *
 * `bytes` 는 화면이 보내온 값이 아니라 **실제 길이와 같아야 한다**(`file_bytes_match`).
 * 애플리케이션이 세는 값만 믿으면, 한 번 틀린 값이 목록·용량 집계에 계속 남는다.
 *
 * 기존 Vercel Blob URL 은 **건드리지 않는다.** 리포트 PNG 가 이미 그 주소로 저장돼 있고,
 * 어느 것이 어느 저장소인지는 주소 모양으로 갈린다(`/files/{id}` = Neon · `https://` = 레거시).
 * 추정해서 옮기면 원장이 거짓이 된다 (추정 이관 금지).
 */
export class FileStore1758800000000 implements MigrationInterface {
  name = 'FileStore1758800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS file (
      id bigserial NOT NULL,
      kind varchar(24) NOT NULL,
      name varchar(200) NOT NULL,
      mime varchar(100) NOT NULL,
      bytes integer NOT NULL,
      sha256 char(64) NOT NULL,
      data bytea NOT NULL,
      uploaded_by bigint,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    )`);
    await q.query(
      `COMMENT ON TABLE file IS '올린 파일 본문 — Neon 안에 둔다 (대표 결정 2026-09-12 · D6 · A-D4)'`,
    );
    await q.query(
      `COMMENT ON COLUMN file.kind IS '어디에 쓰이는 파일인가 — 열람 권한이 이 낱말로 갈린다'`,
    );
    await q.query(
      `ALTER TABLE file ADD CONSTRAINT file_size_cap CHECK (bytes > 0 AND bytes <= 8388608)`,
    );
    await q.query(
      `ALTER TABLE file ADD CONSTRAINT file_bytes_match CHECK (octet_length(data) = bytes)`,
    );
    await q.query(
      `ALTER TABLE file ADD CONSTRAINT file_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')`,
    );
    await q.query(
      `ALTER TABLE file ADD CONSTRAINT file_uploader_fk FOREIGN KEY (uploaded_by) REFERENCES staff(id)`,
    );
    await q.query(`CREATE INDEX file_kind_at_idx ON file (kind, uploaded_at DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS file`);
  }
}
