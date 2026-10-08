/** @file-guide
 * 목적: 강사 불가시간과 실제 수업 편성이 공유하는 잠금·충돌 판정.
 * 책임/재사용: 강사 등록과 schedule projection이 같은 강사 잠금을 사용하고, 실제 ser_occ.span만 충돌 정본으로 읽는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { EntityManager, QueryRunner } from 'typeorm';
import { END_MIN, START_MIN, kstDateOf } from './sql';

type Queryable = Pick<EntityManager, 'query'> | Pick<QueryRunner, 'query'>;

export interface TeacherUnavailableLessonConflict {
  serId: number;
  onDate: string;
  actualDate: string;
  startMin: number;
  endMin: number;
  title: string | null;
}

/**
 * 권고안 채택(BOC-06D-01, 2026-10-08): 불가시간과 시간표 쓰기는 강사 단위 advisory lock을 공유한다.
 * 날짜별 잠금보다 범위는 넓지만 반복수업 이동·복사처럼 여러 날짜를 한 번에 투영해도 잠금 순서가 단순하고,
 * 기존 관리자 편성의 UNAV 경고 정책은 유지한다. 정책을 바꾸면 teacher writer·schedule projection·BOC-06 문서를 함께 갱신한다.
 */
export async function lockTeacherUnavailableWrite(q: Queryable, teacherIds: ReadonlyArray<number | null>): Promise<void> {
  const ids = [...new Set(teacherIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0))]
    .sort((a, b) => a - b);
  for (const teacherId of ids) {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('unav-write'), $1::int)`, [teacherId]);
  }
}

/** 실제 달력일(span)과 분 범위가 겹치는 열린 담당 회차 한 건. on_date는 원래 회차 키로 함께 돌려준다. */
export async function findTeacherUnavailableLessonConflict(
  q: Queryable,
  teacherId: number,
  actualDate: string,
  startMin: number,
  endMin: number,
): Promise<TeacherUnavailableLessonConflict | null> {
  const rows = (await q.query(
    `SELECT o.ser_id,
            to_char(o.on_date, 'YYYY-MM-DD') AS on_date,
            to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS actual_date,
            ${START_MIN} AS start_min,
            ${END_MIN} AS end_min,
            NULLIF(s.title, '') AS title
       FROM ser_occ o
       JOIN ser s ON s.id = o.ser_id
      WHERE COALESCE(o.teacher_id, s.teacher_id) = $1
        AND NOT o.canceled
        AND ${kstDateOf('lower(o.span)')} = $2::date
        AND ${START_MIN} < $4
        AND ${END_MIN} > $3
      ORDER BY lower(o.span), o.ser_id, o.on_date
      LIMIT 1`,
    [teacherId, actualDate, startMin, endMin],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    serId: Number(row.ser_id),
    onDate: String(row.on_date),
    actualDate: String(row.actual_date),
    startMin: Number(row.start_min),
    endMin: Number(row.end_min),
    title: row.title == null ? null : String(row.title),
  };
}
