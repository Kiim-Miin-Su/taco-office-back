/** @file-guide
 * 목적: file 테이블 ORM 매핑 — FileRow (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * FILE — 올린 파일 본문. **Neon 안에 둔다** (대표 결정 2026-09-12 · D6 · A-D4).
 *
 * 이름이 `File` 이면 Node 전역 `File` 과 겹쳐 읽는 사람이 헷갈린다 — `FileRow` 로 부른다.
 * 표 이름은 `file` 그대로다.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['kind', 'uploadedAt'])
@Entity({ name: 'file' })
export class FileRow {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 어디에 쓰이는 파일인가 — 열람 권한이 이 낱말로 갈린다 */
  @Column({ type: 'varchar', length: 24 })
  kind: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 100 })
  mime: string;

  /** 실제 길이와 같아야 한다 — CHECK `file_bytes_match` */
  @Column({ type: 'int' })
  bytes: number;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @Column({ type: 'bytea' })
  data: Buffer;

  @Column({ type: 'bigint', nullable: true })
  uploadedBy: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  uploadedAt: Date;
}
