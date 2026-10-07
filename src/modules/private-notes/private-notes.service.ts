/** @file-guide
 * 목적: 강사 관리자전용 특이사항의 회차·학생·작성자 검증, 멱등·낙관 잠금과 역할별 projection을 소유한다. (service)
 * 책임/재사용: 기존 NOTE를 재사용하지 않으며 본문은 관리자 학생별 endpoint에서만 반환한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · migration 1767000000000
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { audit } from '../../lib/audit';
import type {
  AdminStudentPrivateNoteListDto, TeacherPrivateNoteReceiptDto, TeacherPrivateNoteReceiptListDto,
  TeacherPrivateNoteWriteDto,
} from './private-notes.dto';

type Row = Record<string, unknown>;
const fingerprintOf = (dto: TeacherPrivateNoteWriteDto, body: string): string => createHash('sha256').update(JSON.stringify({
  studentId: dto.studentId, serId: dto.serId, onDate: dto.onDate, body, expectedVersion: dto.expectedVersion,
})).digest('hex');

@Injectable()
export class PrivateNotesService {
  constructor(private readonly ds: DataSource) {}

  private receipt(row: Row): TeacherPrivateNoteReceiptDto {
    return {
      id: Number(row.id), studentId: Number(row.student_id), studentName: String(row.student_name),
      serId: Number(row.ser_id), onDate: String(row.on_date), version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private async noteReceipt(m: EntityManager | DataSource, id: number): Promise<TeacherPrivateNoteReceiptDto> {
    const [row] = await m.query(`SELECT n.id,n.student_id,s.name AS student_name,n.ser_id,n.on_date::text,
      n.version,n.created_at::text,n.updated_at::text
      FROM teacher_private_note n JOIN stu s ON s.id=n.student_id WHERE n.id=$1`, [id]) as Row[];
    if (!row) throw new NotFoundException({ code: 'TEACHER_PRIVATE_NOTE_NOT_FOUND', message: '특이사항을 찾을 수 없습니다' });
    return this.receipt(row);
  }

  /**
   * 권고안 채택(BOC-09D-03): actor+원래 회차일+학생+version을 서버에서 검증한다. 같은
   * requestKey의 같은 payload만 수렴하며, 본문은 응답·LOG·NOTI에 싣지 않는다. 정책 변경 시
   * TeacherPrivateNoteDraft, 생성 OpenAPI, migration/두 DBML, 두 수정사항 대조표와 portfolio를 함께 고친다.
   */
  async write(actorId: number, dto: TeacherPrivateNoteWriteDto): Promise<TeacherPrivateNoteReceiptDto> {
    const body = dto.body.trim();
    if (!body) throw new BadRequestException({ code: 'TEACHER_PRIVATE_NOTE_EMPTY', message: '특이사항 내용을 입력해 주세요' });
    const fingerprint = fingerprintOf(dto, body);
    return this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('teacher-private-note-write'),hashtext($1))`, [dto.requestKey]);
      const [prior] = await m.query(`SELECT note_id,actor_id,fingerprint,result_version
        FROM teacher_private_note_write_req WHERE request_key=$1`, [dto.requestKey]) as Row[];
      if (prior) {
        if (Number(prior.actor_id) !== actorId || String(prior.fingerprint) !== fingerprint) {
          throw new ConflictException({
            code: 'TEACHER_PRIVATE_NOTE_REQUEST_KEY_REUSED',
            message: '같은 특이사항 요청 키를 다른 내용에 다시 사용할 수 없습니다',
          });
        }
        const receipt = await this.noteReceipt(m, Number(prior.note_id));
        if (receipt.version !== Number(prior.result_version)) throw new ConflictException({
          code: 'TEACHER_PRIVATE_NOTE_REPLAY_STALE',
          message: '이 요청 뒤에 특이사항이 다시 수정되었습니다 — 최신 수업 기록을 확인하세요',
        });
        return receipt;
      }

      const [occurrence] = await m.query(`SELECT o.ser_id,o.on_date::text,
          COALESCE(o.teacher_id,s.teacher_id) AS teacher_id,
          (o.canceled OR COALESCE(a.result,'completed')='canceled') AS canceled,
          upper(o.span) <= now() AS completed
        FROM ser_occ o JOIN ser s ON s.id=o.ser_id
        LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
        WHERE o.ser_id=$1 AND o.on_date=$2::date FOR SHARE OF o`, [dto.serId, dto.onDate]) as Row[];
      if (!occurrence || Number(occurrence.teacher_id) !== actorId) throw new NotFoundException({
        code: 'TEACHER_PRIVATE_NOTE_TARGET_NOT_FOUND', message: '내 완료 수업의 학생을 찾을 수 없습니다',
      });
      if (occurrence.canceled || !occurrence.completed) throw new ConflictException({
        code: 'TEACHER_PRIVATE_NOTE_LESSON_NOT_COMPLETED', message: '진행 완료 수업에만 특이사항을 남길 수 있습니다',
      });
      const [student] = await m.query(`SELECT s.id FROM stu s
        JOIN ser_stu ss ON ss.student_id=s.id AND ss.ser_id=$1
          AND (ss.from_date IS NULL OR ss.from_date <= $2::date)
          AND (ss.to_date IS NULL OR ss.to_date >= $2::date)
        WHERE s.id=$3 AND NOT EXISTS (
          SELECT 1 FROM exc e JOIN exc_stu_out x ON x.exc_id=e.id AND x.student_id=s.id
           WHERE e.ser_id=$1 AND e.on_date=$2::date
        )`, [dto.serId, dto.onDate, dto.studentId]) as Row[];
      if (!student) throw new NotFoundException({
        code: 'TEACHER_PRIVATE_NOTE_TARGET_NOT_FOUND', message: '내 완료 수업의 학생을 찾을 수 없습니다',
      });

      const [current] = await m.query(`SELECT id,body,version FROM teacher_private_note
        WHERE author_id=$1 AND ser_id=$2 AND on_date=$3::date AND student_id=$4 FOR UPDATE`,
      [actorId, dto.serId, dto.onDate, dto.studentId]) as Row[];
      if ((!current && dto.expectedVersion !== 0) || (current && Number(current.version) !== dto.expectedVersion)) {
        throw new ConflictException({
          code: 'TEACHER_PRIVATE_NOTE_VERSION_CONFLICT',
          message: '다른 저장 결과가 있습니다 — 수업 기록을 새로고침해 주세요',
        });
      }

      let noteId: number;
      let version: number;
      if (!current) {
        const [made] = await m.query(`INSERT INTO teacher_private_note(student_id,ser_id,on_date,author_id,body)
          VALUES($1,$2,$3::date,$4,$5) RETURNING id,version`, [dto.studentId, dto.serId, dto.onDate, actorId, body]) as Row[];
        noteId = Number(made.id); version = Number(made.version);
      } else if (String(current.body) === body) {
        noteId = Number(current.id); version = Number(current.version);
      } else {
        // TypeORM/PostgreSQL의 raw UPDATE는 `[rows, affected]`다. INSERT와 같은 모양으로
        // 해석하면 `id/version`이 NaN이 되어 receipt FK에서만 늦게 드러난다.
        const [changedRows] = await m.query(`UPDATE teacher_private_note SET body=$2,version=version+1
          WHERE id=$1 AND version=$3 RETURNING id,version`, [current.id, body, dto.expectedVersion]) as [Row[], number];
        const changed = changedRows[0];
        if (!changed) throw new ConflictException({
          code: 'TEACHER_PRIVATE_NOTE_VERSION_CONFLICT', message: '다른 저장 결과가 있습니다 — 수업 기록을 새로고침해 주세요',
        });
        noteId = Number(changed.id); version = Number(changed.version);
      }
      await m.query(`INSERT INTO teacher_private_note_write_req(request_key,note_id,fingerprint,result_version,actor_id)
        VALUES($1,$2,$3,$4,$5)`, [dto.requestKey, noteId, fingerprint, version, actorId]);
      await audit(m, 'teacher.private_note', {
        actorId, entityId: noteId, before: current ? { version: Number(current.version) } : null,
        after: { studentId: dto.studentId, serId: dto.serId, onDate: dto.onDate, version },
      });
      return this.noteReceipt(m, noteId);
    });
  }

  async receipts(actorId: number): Promise<TeacherPrivateNoteReceiptListDto> {
    const rows = await this.ds.query(`SELECT n.id,n.student_id,s.name AS student_name,n.ser_id,n.on_date::text,
      n.version,n.created_at::text,n.updated_at::text FROM teacher_private_note n
      JOIN stu s ON s.id=n.student_id WHERE n.author_id=$1 ORDER BY n.updated_at DESC,n.id DESC LIMIT 20`, [actorId]) as Row[];
    return { items: rows.map((row) => this.receipt(row)) };
  }

  async studentNotes(studentId: number): Promise<AdminStudentPrivateNoteListDto> {
    const [student] = await this.ds.query(`SELECT id FROM stu WHERE id=$1`, [studentId]) as Row[];
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
    const rows = await this.ds.query(`SELECT n.id,n.student_id,s.name AS student_name,n.ser_id,n.on_date::text,
      n.version,n.created_at::text,n.updated_at::text,n.author_id,a.name AS author_name,n.body
      FROM teacher_private_note n JOIN stu s ON s.id=n.student_id JOIN staff a ON a.id=n.author_id
      WHERE n.student_id=$1 ORDER BY n.updated_at DESC,n.id DESC`, [studentId]) as Row[];
    return { studentId, items: rows.map((row) => ({
      ...this.receipt(row), authorId: Number(row.author_id), authorName: String(row.author_name), body: String(row.body),
    })) };
  }
}
