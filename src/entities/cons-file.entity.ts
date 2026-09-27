/** @file-guide
 * 목적: §30 계약서/서명본과 공용 FILE 원장을 잇는 링크만 저장한다.
 * 책임/재사용: 파일 본문·MIME·해시는 FILE/FilesService가 단일 진실원이며 여기서 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ConsultingFileRole } from '../modules/consulting/consulting.rules';

@Entity({ name: 'cons_file' })
@Index(['consId', 'createdAt'])
@Check('cons_file_role_check', "role IN ('draft','revision','signed','item')")
@Check('cons_file_item_pair_check', "(role = 'item') = (item_id IS NOT NULL)")
export class ConsFile {
  @PrimaryColumn({ type: 'bigint' }) fileId: number;
  @Column({ type: 'bigint' }) consId: number;
  @Column({ type: 'varchar', length: 12 }) role: ConsultingFileRole;
  @Column({ type: 'bigint' }) createdBy: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  /**
   * §31 항목 파일(N-63 · migration 1764500000000) — 있으면 그 항목(`cons_item`)의 파일이고 role 은 `item` 이다(짝 CHECK).
   * 없으면 §30 계약 파일. 한도는 DB 트리거가 따로 센다 — 계약 파일 10개 · 항목마다 6개.
   */
  @Column({ type: 'bigint', nullable: true }) itemId: number | null;
}
