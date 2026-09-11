/** @file-guide
 * 목적: teacher.service.ts — TeacherService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ser } from '../../entities';
import { REPORT_UNWRITTEN_CANDIDATE_DB } from '../../lib/rules';
import { todayKst } from '../../lib/kst';
import type { TeacherHomeDto, TeacherLessonDto } from './teacher.dto';

type R = Record<string, unknown>;

/** 회차의 담당 강사 — 회차 오버라이드가 있으면 그것, 없으면 규칙의 강사 (ser_occ.teacher_id ?? ser.teacher_id). */
const TEACHER_OF = 'COALESCE(o.teacher_id, s.teacher_id)';

@Injectable()
export class TeacherService {
  constructor(@InjectRepository(Ser) private readonly anyRepo: Repository<Ser>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** 강사 홈 — 서버가 teacherId 로 고정한다. 화면은 거르지 않는다 (D-R39). */
  async home(teacherId: number): Promise<TeacherHomeDto> {
    const today = todayKst();
    const candidates = [...REPORT_UNWRITTEN_CANDIDATE_DB];

    const lessons = (await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
              s.kind_key, s.sub_key, s.mode, s.title,
              rm.name AS room_name, rm.branch AS room_branch, z.label AS zacc_label,
              COALESCE(r.state::text,'none') AS rep_state,
              (SELECT string_agg(st.name, ', ' ORDER BY st.name)
                 FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                WHERE ss.ser_id = o.ser_id) AS students
         FROM ser_occ o
         JOIN ser s        ON s.id = o.ser_id
         LEFT JOIN room rm ON rm.id = COALESCE(o.room_id, s.room_id)
         LEFT JOIN zacc z  ON z.id = o.zacc_id
         LEFT JOIN rep r   ON r.ser_id = o.ser_id AND r.on_date = o.on_date
        WHERE ${TEACHER_OF} = $1
          AND o.on_date BETWEEN $2::date AND $2::date + 7
        ORDER BY o.on_date, start_min`,
      [teacherId, today],
    )).map((r): TeacherLessonDto => ({
      serId: Number(r.ser_id),
      onDate: String(r.on_date),
      startMin: Number(r.start_min),
      durMin: Number(r.dur_min),
      kindKey: String(r.kind_key),
      subKey: (r.sub_key as string) ?? null,
      mode: r.mode === 'online' ? 'online' : 'offline',
      title: (r.title as string) ?? null,
      roomName: (r.room_name as string) ?? null,
      roomBranch: (r.room_branch as string) ?? null,
      zaccLabel: (r.zacc_label as string) ?? null,
      students: (r.students as string) ?? null,
      canceled: Boolean(r.canceled),
      repState: String(r.rep_state),
    }));

    const [week] = await this.q(
      `SELECT COUNT(*) FILTER (WHERE NOT o.canceled)::int AS lessons,
              COALESCE(SUM(EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)
                       FILTER (WHERE NOT o.canceled), 0)::int AS minutes,
              COUNT(*) FILTER (WHERE NOT o.canceled AND upper(o.span) < now()
                                 AND COALESCE(r.state::text,'none') = ANY($3))::int AS unwritten
         FROM ser_occ o
         JOIN ser s      ON s.id = o.ser_id
         LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
        WHERE ${TEACHER_OF} = $1
          AND o.on_date BETWEEN date_trunc('week',$2::date)::date
                            AND date_trunc('week',$2::date)::date + 6`,
      [teacherId, today, candidates],
    );

    const [todo] = await this.q(
      `SELECT (SELECT COUNT(*)::int
                 FROM ser_occ o JOIN ser s ON s.id = o.ser_id
                 LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
                WHERE ${TEACHER_OF} = $1 AND NOT o.canceled AND upper(o.span) < now()
                  AND COALESCE(r.state::text,'none') = ANY($2)) AS unwritten_reports,
              (SELECT COUNT(*)::int FROM rep WHERE teacher_id = $1 AND state = 'wait') AS waiting_approvals,
              (SELECT COUNT(*)::int FROM chreq WHERE by_id = $1 AND state = 'pending') AS open_change_requests,
              (SELECT COUNT(*)::int FROM req   WHERE staff_id = $1 AND state = 'pending') AS open_staff_requests`,
      [teacherId, candidates],
    );

    const [me] = await this.q(
      `SELECT s.name, s.tz,
              w.rate AS wage_rate, to_char(w.from_date,'YYYY-MM-DD') AS wage_from
         FROM staff s
         LEFT JOIN LATERAL (
                SELECT rate, from_date FROM wage
                 WHERE staff_id = s.id AND from_date <= $2::date
                 ORDER BY from_date DESC LIMIT 1
              ) w ON true
        WHERE s.id = $1`,
      [teacherId, today],
    );

    return {
      todayDate: today,
      today: lessons.filter((l) => l.onDate === today),
      upcoming: lessons.filter((l) => l.onDate > today),
      week: {
        lessons: Number(week?.lessons ?? 0),
        minutes: Number(week?.minutes ?? 0),
        unwritten: Number(week?.unwritten ?? 0),
      },
      todo: {
        unwrittenReports: Number(todo?.unwritten_reports ?? 0),
        waitingApprovals: Number(todo?.waiting_approvals ?? 0),
        openChangeRequests: Number(todo?.open_change_requests ?? 0),
        openStaffRequests: Number(todo?.open_staff_requests ?? 0),
      },
      settings: {
        name: String(me?.name ?? ''),
        timezone: String(me?.tz ?? 'Asia/Seoul'),
        wageRate: me?.wage_rate === null || me?.wage_rate === undefined ? null : Number(me.wage_rate),
        wageFrom: (me?.wage_from as string) ?? null,
      },
    };
  }
}
