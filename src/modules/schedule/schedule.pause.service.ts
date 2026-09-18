/** @file-guide
 * 목적: schedule.pause.service.ts — SchedulePauseService (service)
 * 책임/재사용: 학생 휴원·복귀 쓰기를 한 트랜잭션으로 소유한다. 기간 판정은 lib/sql.stuPausedOn 한 곳이며 회차를 지우지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 휴원 · 복귀 (C92-c · 테스트 시나리오 C-36 「장기 휴원」 · C-37 「복귀」).
 *
 * 휴원은 **회차를 지우는 일이 아니다** — 기간 하나를 `stu_pause` 에 적으면 시간표(`ScheduleService`)·
 * 수업료(`accounting.tuition` · `invoice-lines`)·명단이 그 기간의 회차를 「그날만 빠짐」과 같은 것으로 읽는다
 * (`lib/sql.stuPausedOn` 한 곳). 복귀하면 `to_date` 를 복귀 전날로 당길 뿐이라 회차는 그대로 돌아온다.
 * 기간은 이력으로 남는다 (지우지 않는다 · 누가 잡고 누가 복귀시켰는지가 같은 행에 있다).
 *
 * 겹치는 기간은 DB EXCLUDE(`stu_pause_no_overlap`) 가 막고 오류 필터가 `PAUSE_OVERLAP` 으로 번역한다 —
 * 서비스가 먼저 SELECT 로 겹침을 보지 않는다 (그 사이에 다른 요청이 잡을 수 있다 · D-R43).
 *
 * 「빠지는 회차 수」는 서버가 센다 (D-R37) — 화면이 회차를 다시 훑으면 §54 와 다른 수를 말한다.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { addDays } from '../../lib/kst';
import { writtenRows } from '../../lib/sql';
import type { StudentPauseResultDto, StudentPauseWriteDto, StudentResumeWriteDto } from './schedule.dto';

interface PauseRow {
  id: string;
  student_id: string;
  from_date: string;
  to_date: string | null;
  reason: string | null;
  resumed_at: Date | string | null;
}

/** 복귀·기록에 쓰는 한 줄 — LOG before/after 도 이 모양이다 */
interface PauseSnapshot {
  studentId: number;
  fromDate: string;
  toDate: string | null;
  reason: string | null;
  resumedAt: string | null;
}

@Injectable()
export class SchedulePauseService {
  constructor(private readonly ds: DataSource) {}

  async pause(studentId: number, dto: StudentPauseWriteDto, actorId: number): Promise<StudentPauseResultDto> {
    if (dto.toDate !== undefined && dto.toDate < dto.fromDate) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '휴원 종료일이 시작일보다 앞입니다' });
    }
    const reason = dto.reason?.trim() || null;

    return this.tx(async (q) => {
      await this.assertStudent(q, studentId);
      const [row] = await q.query(
        `INSERT INTO stu_pause (student_id, from_date, to_date, reason, by_id)
         VALUES ($1, $2::date, $3::date, $4, $5)
         RETURNING id, student_id, from_date::text, to_date::text, reason, resumed_at`,
        [studentId, dto.fromDate, dto.toDate ?? null, reason, actorId],
      ) as PauseRow[];
      const after = snapshot(row);
      const affected = await this.countOccurrences(q, studentId, after.fromDate, after.toDate);
      await this.log(q, actorId, Number(row.id), 'create', null, after);
      return { id: Number(row.id), ...after, resumed: after.resumedAt !== null, affected };
    });
  }

  async resume(
    studentId: number,
    pauseId: number,
    dto: StudentResumeWriteDto,
    actorId: number,
  ): Promise<StudentPauseResultDto> {
    return this.tx(async (q) => {
      const [row] = await q.query(
        `SELECT id, student_id, from_date::text, to_date::text, reason, resumed_at
           FROM stu_pause WHERE id = $1 AND student_id = $2 FOR UPDATE`,
        [pauseId, studentId],
      ) as PauseRow[];
      if (!row) {
        throw new NotFoundException({ code: 'PAUSE_NOT_FOUND', message: '휴원 기록이 없습니다' });
      }
      const before = snapshot(row);
      if (before.resumedAt) {
        throw new ConflictException({ code: 'PAUSE_ALREADY_RESUMED', message: '이미 복귀 처리한 휴원입니다' });
      }
      // 복귀일은 휴원 첫날 다음 날부터다 — 첫날에 복귀하면 휴원한 날이 없는 기록이 된다.
      // 잘못 잡은 휴원은 「없던 일」이 아니라 이력이므로 지우는 길을 두지 않는다 (N-25 · 기록은 남긴다).
      if (dto.resumeOn <= before.fromDate) {
        throw new BadRequestException({ code: 'BAD_RANGE', message: '복귀일은 휴원 시작일 다음 날부터 고를 수 있습니다' });
      }
      const newTo = addDays(dto.resumeOn, -1);
      // 이미 끝난 기간을 복귀로 더 늘리지 않는다 — 늘리는 것은 새 휴원이다.
      if (before.toDate !== null && newTo > before.toDate) {
        throw new BadRequestException({ code: 'BAD_RANGE', message: '복귀일이 휴원 종료일보다 뒤입니다 — 기간을 늘리려면 휴원을 새로 잡아 주세요' });
      }
      const [updated] = writtenRows<PauseRow>(await q.query(
        `UPDATE stu_pause
            SET to_date = $2::date, resumed_by = $3, resumed_at = now()
          WHERE id = $1
          RETURNING id, student_id, from_date::text, to_date::text, reason, resumed_at`,
        [pauseId, newTo, actorId],
      ));
      const after = snapshot(updated!);
      // 돌아오는 회차 — 복귀일부터 원래 종료일(무기한이면 투영 끝)까지
      const affected = await this.countOccurrences(q, studentId, dto.resumeOn, before.toDate);
      await this.log(q, actorId, pauseId, 'resume', before, after);
      return { id: pauseId, ...after, resumed: after.resumedAt !== null, affected };
    });
  }

  private async assertStudent(q: QueryRunner, studentId: number): Promise<void> {
    const rows = await q.query(`SELECT 1 FROM stu WHERE id = $1`, [studentId]) as unknown[];
    if (rows.length === 0) {
      throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생이 없습니다' });
    }
  }

  /**
   * 기간 안에서 그 학생에게 서는 회차 수 — 취소 아닌 회차 중 「그날만 빠짐」이 아닌 것.
   * `on_date` 로 센다 — 시간표·§54 가 휴원을 판정하는 날짜와 같은 축이다 (`stuPausedOn`).
   */
  private async countOccurrences(q: QueryRunner, studentId: number, from: string, to: string | null): Promise<number> {
    const [row] = await q.query(
      `SELECT count(*)::int AS n
         FROM ser_occ o
         JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ss.student_id = $1
        WHERE NOT o.canceled
          AND o.on_date >= $2::date
          AND ($3::date IS NULL OR o.on_date <= $3::date)
          AND NOT EXISTS (
            SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
             WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND xo.student_id = ss.student_id
          )`,
      [studentId, from, to],
    ) as { n: number }[];
    return row?.n ?? 0;
  }

  private async log(
    q: QueryRunner,
    actorId: number,
    entityId: number,
    action: 'create' | 'resume',
    before: PauseSnapshot | null,
    after: PauseSnapshot,
  ): Promise<void> {
    await q.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
       VALUES ($1,'STU_PAUSE',$2,$3,$4::jsonb,$5::jsonb)`,
      [actorId, entityId, action, before ? JSON.stringify(before) : null, JSON.stringify(after)],
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

function snapshot(row: PauseRow): PauseSnapshot {
  return {
    studentId: Number(row.student_id),
    fromDate: row.from_date,
    toDate: row.to_date,
    reason: row.reason,
    resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : null,
  };
}
