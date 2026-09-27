/** @file-guide
 * 목적: schedule.attendance.service.ts — ScheduleAttendanceService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  attendanceWriteIssue, canEditAttendance,
  type AttendanceCancelReason, type AttendanceResult,
} from '../../lib/rules';
import { nowMinKst, todayKst } from '../../lib/kst';
import { END_MIN, START_MIN, kstDateOf, serStuOn } from '../../lib/sql';
import { assertMonthOpen } from '../../lib/month-close';
import type { AttendanceDto, AttendanceMutationResultDto, AttendanceWriteDto } from './schedule.dto';
import { lockScheduleSeries } from './schedule.state.repo';

interface OccurrenceLockRow {
  date: string;
  start_min: number;
  end_min: number;
  canceled: boolean;
}

interface AttendanceRow {
  id: string;
  result: AttendanceResult;
  reason: AttendanceCancelReason | null;
  confirmed_by: string;
  confirmed_by_name: string;
  confirmed_at: Date | string;
  late_students: Array<{
    studentId: string | number;
    studentName: string;
    confirmedBy: string | number;
    confirmedByName: string;
    confirmedAt: Date | string;
  }> | null;
}

@Injectable()
export class ScheduleAttendanceService {
  constructor(private readonly ds: DataSource) {}

  async save(
    serId: number,
    onDate: string,
    dto: AttendanceWriteDto,
    actorId: number,
  ): Promise<AttendanceMutationResultDto> {
    const issue = attendanceWriteIssue(dto);
    if (issue === 'ATTENDANCE_REASON_REQUIRED') {
      throw new BadRequestException({ code: issue, message: '취소 사유를 선택해 주세요' });
    }
    if (issue === 'ATTENDANCE_REASON_FORBIDDEN') {
      throw new BadRequestException({ code: issue, message: '완료 출결에는 취소 사유를 넣을 수 없습니다' });
    }
    if (issue === 'ATTENDANCE_LATE_FORBIDDEN') {
      throw new BadRequestException({ code: issue, message: '결석 처리한 회차에는 지각 학생을 함께 기록할 수 없습니다' });
    }

    return this.tx(async (q) => {
      // 마감 달의 출결은 강사료를 바꾼다 — 해제 전에는 못 고친다 (C92-d · L-123)
      await assertMonthOpen(q, onDate);
      await this.assertManageable(q, serId, onDate);
      const before = await this.current(q, serId, onDate, true);
      let attendanceId: number;
      if (before) {
        await q.query(
          `UPDATE att
              SET result=$3, reason=$4, confirmed_by=$5, confirmed_at=now()
            WHERE ser_id=$1 AND on_date=$2::date
            `,
          [serId, onDate, dto.result, dto.reason ?? null, actorId],
        );
        attendanceId = before.id;
      } else {
        const [inserted] = (await q.query(
          `INSERT INTO att (ser_id, on_date, result, reason, confirmed_by)
           VALUES ($1,$2::date,$3,$4,$5)
           RETURNING id`,
          [serId, onDate, dto.result, dto.reason ?? null, actorId],
        )) as Array<{ id: string }>;
        attendanceId = Number(inserted.id);
      }
      if (dto.result === 'canceled') {
        await q.query(`DELETE FROM att_late WHERE att_id=$1`, [attendanceId]);
      } else if (dto.lateStudentIds !== undefined) {
        await this.replaceLateStudents(q, attendanceId, serId, onDate, dto.lateStudentIds, actorId);
      }
      const after = await this.current(q, serId, onDate, false);
      await this.log(q, actorId, after!.id, before ? 'update' : 'create', before, after);
      return { attendance: after };
    });
  }

  /**
   * C-40 지각 현재 목록 교체. 부모 SER 잠금 아래라 명단 변경과 직렬화되며,
   * ATT 쓰기·LOG와 같은 transaction 안에서 전부 성공하거나 전부 되돌아간다.
   */
  private async replaceLateStudents(
    q: QueryRunner,
    attendanceId: number,
    serId: number,
    onDate: string,
    studentIds: number[],
    actorId: number,
  ): Promise<void> {
    const unique = new Set(studentIds);
    if (unique.size !== studentIds.length
      || studentIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new BadRequestException({
        code: 'ATTENDANCE_LATE_STUDENT_INVALID',
        message: '지각 학생은 중복 없는 올바른 학생 ID 목록이어야 합니다',
      });
    }
    if (studentIds.length) {
      const roster = (await q.query(
        `SELECT ss.student_id
           FROM ser_stu ss
          WHERE ss.ser_id=$1 AND ss.student_id = ANY($3::bigint[])
            AND ${serStuOn('ss', '$2::date')}
          ORDER BY ss.student_id
          FOR KEY SHARE OF ss`,
        [serId, onDate, studentIds],
      )) as Array<{ student_id: string }>;
      const found = new Set(roster.map((row) => Number(row.student_id)));
      if (studentIds.some((id) => !found.has(id))) {
        throw new BadRequestException({
          code: 'ATTENDANCE_LATE_STUDENT_NOT_IN_ROSTER',
          message: '이 회차 명단에 없는 학생은 지각으로 표시할 수 없습니다',
        });
      }
    }

    await q.query(`DELETE FROM att_late WHERE att_id=$1`, [attendanceId]);
    if (studentIds.length) {
      await q.query(
        `INSERT INTO att_late (att_id, student_id, confirmed_by)
         SELECT $1, student_id, $3
           FROM unnest($2::bigint[]) AS ids(student_id)`,
        [attendanceId, studentIds, actorId],
      );
    }
  }

  async clear(serId: number, onDate: string, actorId: number): Promise<AttendanceMutationResultDto> {
    return this.tx(async (q) => {
      await assertMonthOpen(q, onDate);
      await this.assertManageable(q, serId, onDate);
      const before = await this.current(q, serId, onDate, true);
      if (!before) {
        throw new NotFoundException({ code: 'ATTENDANCE_NOT_FOUND', message: '초기화할 출결이 없습니다' });
      }
      await q.query(`DELETE FROM att WHERE id=$1`, [before.id]);
      await this.log(q, actorId, before.id, 'clear', before, null);
      return { attendance: null };
    });
  }

  private async assertManageable(q: QueryRunner, serId: number, onDate: string): Promise<void> {
    // project는 SER_OCC를 삭제/재생성한다. 부모 대기 후 새 statement로 조회해야
    // 삭제된 옛 행을 기다리다 잘못된404를 내지 않고 최신 종료/취소 상태를 검증한다.
    await lockScheduleSeries(q, [serId]);
    const rows = await q.query(
      `SELECT to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS date,
              ${START_MIN} AS start_min, ${END_MIN} AS end_min, o.canceled
         FROM ser_occ o
        WHERE o.ser_id=$1 AND o.on_date=$2::date
        FOR UPDATE OF o`,
      [serId, onDate],
    ) as OccurrenceLockRow[];
    const row = rows[0];
    if (!row) {
      throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: '해당 회차를 찾을 수 없습니다' });
    }
    const mode = canEditAttendance(
      { date: row.date, startMin: row.start_min, durationMin: row.end_min - row.start_min, canceled: row.canceled },
      { canCrudAttendance: true, today: todayKst(), nowMin: nowMinKst() },
    );
    if (mode !== 'manage') {
      throw new ConflictException({
        code: 'ATTENDANCE_NOT_AVAILABLE',
        message: row.canceled ? '휴강·취소된 일정에는 출결을 확정할 수 없습니다' : '수업이 끝난 뒤 출결을 확정할 수 있습니다',
      });
    }
  }

  private async current(
    q: QueryRunner,
    serId: number,
    onDate: string,
    lock: boolean,
  ): Promise<AttendanceDto | null> {
    const rows = await q.query(
      `SELECT a.id, a.result, a.reason, a.confirmed_by,
              st.name AS confirmed_by_name, a.confirmed_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'studentId', al.student_id,
                  'studentName', late_st.name,
                  'confirmedBy', al.confirmed_by,
                  'confirmedByName', late_by.name,
                  'confirmedAt', al.confirmed_at
                ) ORDER BY al.student_id)
                  FROM att_late al
                  JOIN stu late_st ON late_st.id=al.student_id
                  JOIN staff late_by ON late_by.id=al.confirmed_by
                 WHERE al.att_id=a.id
              ), '[]'::json) AS late_students
         FROM att a
         JOIN staff st ON st.id=a.confirmed_by
        WHERE a.ser_id=$1 AND a.on_date=$2::date
        ${lock ? 'FOR UPDATE OF a' : ''}`,
      [serId, onDate],
    ) as AttendanceRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      result: row.result,
      reason: row.reason,
      confirmedBy: Number(row.confirmed_by),
      confirmedByName: row.confirmed_by_name,
      confirmedAt: new Date(row.confirmed_at).toISOString(),
      countsForPay: row.result === 'completed',
      lateStudents: (row.late_students ?? []).map((late) => ({
        studentId: Number(late.studentId),
        studentName: late.studentName,
        confirmedBy: Number(late.confirmedBy),
        confirmedByName: late.confirmedByName,
        confirmedAt: new Date(late.confirmedAt).toISOString(),
      })),
    };
  }

  private async log(
    q: QueryRunner,
    actorId: number,
    entityId: number,
    action: 'create' | 'update' | 'clear',
    before: AttendanceDto | null,
    after: AttendanceDto | null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
       VALUES ($1,'ATT',$2,$3,$4::jsonb,$5::jsonb)`,
      [actorId, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
    );
  }

  private async tx<T>(run: (q: QueryRunner) => Promise<T>): Promise<T> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const value = await run(q);
      await q.commitTransaction();
      return value;
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }
}
