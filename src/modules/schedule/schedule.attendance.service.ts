import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  attendanceWriteIssue, canEditAttendance,
  type AttendanceCancelReason, type AttendanceResult,
} from '../../lib/rules';
import { nowMinKst, todayKst } from '../../lib/kst';
import { END_MIN, START_MIN, kstDateOf } from '../../lib/sql';
import type { AttendanceDto, AttendanceMutationResultDto, AttendanceWriteDto } from './schedule.dto';

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

    return this.tx(async (q) => {
      await this.assertManageable(q, serId, onDate);
      const before = await this.current(q, serId, onDate, true);
      if (before) {
        await q.query(
          `UPDATE att
              SET result=$3, reason=$4, confirmed_by=$5, confirmed_at=now()
            WHERE ser_id=$1 AND on_date=$2::date
            `,
          [serId, onDate, dto.result, dto.reason ?? null, actorId],
        );
      } else {
        await q.query(
          `INSERT INTO att (ser_id, on_date, result, reason, confirmed_by)
           VALUES ($1,$2::date,$3,$4,$5)`,
          [serId, onDate, dto.result, dto.reason ?? null, actorId],
        );
      }
      const after = await this.current(q, serId, onDate, false);
      await this.log(q, actorId, after!.id, before ? 'update' : 'create', before, after);
      return { attendance: after };
    });
  }

  async clear(serId: number, onDate: string, actorId: number): Promise<AttendanceMutationResultDto> {
    return this.tx(async (q) => {
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
              st.name AS confirmed_by_name, a.confirmed_at
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
