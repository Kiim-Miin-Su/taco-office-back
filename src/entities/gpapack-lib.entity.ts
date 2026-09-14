/** @file-guide
 * 목적: 자료 전달 한 건과 여러 교재의 연결을 매핑한다.
 * 책임/재사용: 복합키 관계만 소유하며 파일·수령 정책을 판단하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'gpapack_lib' })
export class GpapackLib {
  @PrimaryColumn({ type: 'bigint' }) gpapackId: number;
  @PrimaryColumn({ type: 'bigint' }) libId: number;
  /** 전달 만들기/수정 시 선택한 판. 이후 현재 판이 바뀌어도 과거 전달 파일은 바뀌지 않는다. */
  @Column({ type: 'bigint', nullable: true }) versId: number | null;
}
