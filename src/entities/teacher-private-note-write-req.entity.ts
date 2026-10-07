/** @file-guide
 * 목적: 강사 관리자전용 특이사항 쓰기의 requestKey·본문 fingerprint·결과 version을 매핑한다. (entity)
 * 책임/재사용: 동일 actor·payload 재시도만 같은 결과로 수렴시키며 본문은 저장하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · migration 1767000000000
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'teacher_private_note_write_req' })
@Index('teacher_private_note_write_req_note_idx', ['noteId', 'createdAt'])
@ForeignKey('teacher_private_note', ['noteId'], ['id'], { name: 'teacher_private_note_write_req_note_fk', onDelete: 'CASCADE' })
@ForeignKey('staff', ['actorId'], ['id'], { name: 'teacher_private_note_write_req_actor_fk', onDelete: 'RESTRICT' })
@Check('teacher_private_note_write_req_fingerprint_hex', "fingerprint ~ '^[0-9a-f]{64}$'")
@Check('teacher_private_note_write_req_version_positive', 'result_version >= 1')
export class TeacherPrivateNoteWriteReq {
  @PrimaryColumn({ type: 'uuid' }) requestKey: string;
  @Column({ type: 'bigint' }) noteId: number;
  @Column({ type: 'char', length: 64 }) fingerprint: string;
  @Column({ type: 'int' }) resultVersion: number;
  @Column({ type: 'bigint' }) actorId: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}
