/** @file-guide
 * 목적: §30 계약서/서명본과 공용 FILE 원장을 잇는 링크만 저장한다.
 * 책임/재사용: 파일 본문·MIME·해시는 FILE/FilesService가 단일 진실원이며 여기서 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ConsultingFileRole } from '../modules/consulting/consulting.rules';

@Entity({ name: 'cons_file' })
@Index(['consId', 'createdAt'])
@Check('cons_file_role_check', "role IN ('draft','revision','signed')")
export class ConsFile {
  @PrimaryColumn({ type: 'bigint' }) fileId: number;
  @Column({ type: 'bigint' }) consId: number;
  @Column({ type: 'varchar', length: 12 }) role: ConsultingFileRole;
  @Column({ type: 'bigint' }) createdBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
