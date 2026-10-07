/** @file-guide
 * 목적: BO-09E-01 관리자 Kinder 표식 조회·append writer와 장래 일반 그룹 충돌 검사를 소유한다.
 * 책임/재사용: 월 마감→Kinder→학생/SER 잠금 순서, 공용 반복수업 판정, marker version을 한 transaction으로 묶는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import { assertKinderRosterState, type KinderMarkerEvent } from '../../lib/kinder-roster';
import { loadKinderMarkerEvents, lockKinderRosterPolicyWrite, throwKinderConflict } from '../../lib/kinder-roster.db';
import { loadState } from '../schedule/schedule.state.repo';
import type {
  StudentKinderMarkerCreateDto, StudentKinderMarkerDto, StudentKinderMarkerHistoryDto,
} from './student-kinder.dto';

type MarkerRow = {
  id: string; student_id: string; version: number; marked: boolean; effective_from: Date;
  reason: string | null; set_by: string; set_by_name: string; created_at: Date;
};

const markerDto = (row: MarkerRow): StudentKinderMarkerDto => ({
  id: Number(row.id), studentId: Number(row.student_id), version: Number(row.version), marked: row.marked,
  effectiveFrom: row.effective_from.toISOString(), reason: row.reason, setBy: Number(row.set_by),
  setByName: row.set_by_name, createdAt: row.created_at.toISOString(),
});

async function markerRows(q: Pick<QueryRunner, 'query'>, studentId: number): Promise<MarkerRow[]> {
  return q.query(
    `SELECT m.id,m.student_id,m.version,m.marked,m.effective_from,m.reason,m.set_by,
            st.name AS set_by_name,m.created_at
       FROM stu_kinder_marker m JOIN staff st ON st.id=m.set_by
      WHERE m.student_id=$1 ORDER BY m.version`, [studentId],
  ) as Promise<MarkerRow[]>;
}

@Injectable()
export class StudentKinderService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async history(studentId: number): Promise<StudentKinderMarkerHistoryDto> {
    const exists = await this.ds.query(`SELECT 1 FROM stu WHERE id=$1`, [studentId]) as unknown[];
    if (!exists.length) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
    const items = (await markerRows(
      { query: (sql, parameters) => this.ds.query(sql, parameters) } as Pick<QueryRunner, 'query'>,
      studentId,
    )).map(markerDto);
    const now = Date.now();
    const current = [...items].reverse().find((item) => Date.parse(item.effectiveFrom) <= now) ?? null;
    return { studentId, currentVersion: items.at(-1)?.version ?? 0, current, items };
  }

  async create(
    actorId: number,
    studentId: number,
    dto: StudentKinderMarkerCreateDto,
    outer?: QueryRunner,
  ): Promise<StudentKinderMarkerDto> {
    const effectiveMs = Date.parse(dto.effectiveFrom);
    if (!Number.isFinite(effectiveMs) || effectiveMs <= Date.now()) {
      throw new BadRequestException({ code: 'KINDER_MARKER_NOT_FUTURE', message: 'Kinder 표식은 미래 실제 수업 시작부터 적용해야 합니다' });
    }
    const reason = dto.reason?.trim() || null;
    if (dto.reason !== undefined && reason === null) {
      throw new BadRequestException({ code: 'KINDER_MARKER_REASON_EMPTY', message: '사유는 공백만 입력할 수 없습니다' });
    }
    const q = outer ?? this.ds.createQueryRunner();
    const ownsTransaction = outer === undefined;
    if (ownsTransaction) {
      await q.connect();
      await q.startTransaction();
    }
    try {
      // 권고안 채택: 표시/명단 경합의 잠금 순서는 월 마감 공유 → Kinder 배타 → 학생/SER 업무 행이다.
      await lockKinderRosterPolicyWrite(q);
      const student = await q.query(`SELECT id FROM stu WHERE id=$1 FOR UPDATE`, [studentId]) as unknown[];
      if (!student.length) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const prior = await loadKinderMarkerEvents(q, [studentId]);
      const currentVersion = prior.reduce((max, row) => Math.max(max, row.version), 0);
      if (dto.expectedVersion !== currentVersion) {
        throw new ConflictException({
          code: 'KINDER_MARKER_VERSION_CONFLICT',
          message: 'Kinder 표식이 다른 화면에서 바뀌었습니다. 최신 이력을 다시 불러와 주세요',
          currentVersion,
        });
      }
      const serRows = await q.query(
        `SELECT DISTINCT ser_id FROM ser_stu WHERE student_id=$1 ORDER BY ser_id`, [studentId],
      ) as Array<{ ser_id: string }>;
      const serIds = serRows.map((row) => Number(row.ser_id));
      const state = await loadState(q, serIds, { forWrite: true });
      const allStudentIds = [...new Set(state.SER_STU.map((row) => row.studentId))];
      const markers = await loadKinderMarkerEvents(q, allStudentIds);
      const candidate: KinderMarkerEvent = {
        studentId, marked: dto.marked, effectiveFrom: new Date(effectiveMs).toISOString(), version: currentVersion + 1,
      };
      try {
        assertKinderRosterState(state, [...markers, candidate]);
      } catch (error) {
        throwKinderConflict(error);
      }
      const [inserted] = await q.query(
        `INSERT INTO stu_kinder_marker(student_id,version,marked,effective_from,reason,set_by)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [studentId, candidate.version, candidate.marked, candidate.effectiveFrom, reason, actorId],
      ) as Array<{ id: string }>;
      const [row] = (await markerRows(q, studentId)).filter((item) => item.id === inserted!.id);
      if (ownsTransaction) await q.commitTransaction();
      return markerDto(row!);
    } catch (error) {
      if (ownsTransaction && q.isTransactionActive) await q.rollbackTransaction();
      throw error;
    } finally {
      if (ownsTransaction) await q.release();
    }
  }
}
