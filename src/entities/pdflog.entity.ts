/** @file-guide
 * 목적: pdflog 테이블 ORM 매핑 — Pdflog (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * PDFLOG — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn } from 'typeorm';

@Check('pdflog_sha256_hex', "sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'")
@Index('pdflog_rep_idx', ['repId'], { where: '"rep_id" IS NOT NULL' })
@ForeignKey('rep', ['repId'], ['id'], { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
@Entity({ name: 'pdflog' })
export class Pdflog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'bigint', nullable: true })
  refId: number | null;

  @Column({ type: 'text', nullable: true })
  fileUrl: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  at: Date;

  /**
   * 이 파일이 **어느 리포트의 것인지**(W11 · 7-3 ① F3 · migration 1764400000000). 한 RSEND 가 학생 하루치 여러 장을
   * 묶으므로 `ref_id` 만으로는 장과 리포트를 짝지을 수 없었다. 옛 행은 NULL(N-25) — 읽는 쪽은 그때 묶음 전체로 판정한다.
   */
  @Column({ type: 'bigint', nullable: true })
  repId: number | null;

  /**
   * 보존한 PNG 바이트의 SHA-256(소문자 16진 64자 · migration 1765200000000 · CR-BE-03). 같은 requestKey 의 멱등 재시도가
   * 파일명·revision·본문에 더해 **바이트**까지 대조하는 열쇠다 — 같은 키 · 다른 바이트는 409 로 거절한다.
   * 재발송은 원본 장의 값을 복사한다. 옛 행은 NULL(N-25 — 되짚어 해시할 원본이 없다 · 읽는 쪽은 그 장의 대조를 건너뛴다).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256: string | null;
}
