/** @file-guide
 * 목적: 자료 전달 한 건과 여러 학생의 연결을 매핑한다.
 * 책임/재사용: 복합키 관계만 소유하며 자료 전달 상태나 권한을 판단하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'gpapack_student' })
export class GpapackStudent {
  @PrimaryColumn({ type: 'bigint' }) gpapackId: number;
  @PrimaryColumn({ type: 'bigint' }) studentId: number;
}
