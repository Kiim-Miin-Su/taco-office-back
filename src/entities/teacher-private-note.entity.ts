/** @file-guide
 * 목적: 강사가 완료 회차에서 남긴 관리자 전용 학생 특이사항 원장을 매핑한다. (entity)
 * 책임/재사용: 본문·회차·학생·작성자·낙관 잠금 version만 소유하며 기존 관리자→강사 NOTE와 섞지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · migration 1767000000000
 */
import { Check, Column, Entity, ForeignKey, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'teacher_private_note' })
@Unique('teacher_private_note_target_unique', ['authorId', 'serId', 'onDate', 'studentId'])
@Index('teacher_private_note_student_idx', ['studentId', 'updatedAt', 'id'])
@Index('teacher_private_note_author_idx', ['authorId', 'updatedAt', 'id'])
@ForeignKey('staff', ['authorId'], ['id'], { name: 'teacher_private_note_author_fk', onDelete: 'RESTRICT' })
@ForeignKey('ser', ['serId'], ['id'], { name: 'teacher_private_note_ser_fk', onDelete: 'RESTRICT' })
@ForeignKey('stu', ['studentId'], ['id'], { name: 'teacher_private_note_student_fk', onDelete: 'RESTRICT' })
@Check('teacher_private_note_body_len', 'char_length(btrim(body)) BETWEEN 1 AND 2000')
@Check('teacher_private_note_version_positive', 'version >= 1')
export class TeacherPrivateNote {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint' }) studentId: number;
  @Column({ type: 'bigint' }) serId: number;
  @Column({ type: 'date' }) onDate: string;
  @Column({ type: 'bigint' }) authorId: number;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'int', default: 1 }) version: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}
