/** @file-guide
 * 목적: teacher.service.ts — TeacherService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ser } from '../../entities';
import {
  REPORT_UNWRITTEN_CANDIDATE_DB, REPORT_WRITTEN_DB,
  latePenalty, minutesSinceEnd, tierFor, withholding, type SessionLike,
} from '../../lib/rules';
import { nowMinKst, todayKst } from '../../lib/kst';
import type {
  TeacherHistoryDto, TeacherHistoryLessonDto, TeacherHomeDto, TeacherLessonDto,
} from './teacher.dto';

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

  /**
   * 수업 히스토리 — 월 기록 + 본인 정산 (덱 §29~31).
   *
   * 정산 규칙은 전부 lib/rules 정본을 소비한다: 인정 = 제출분(D-R7 — 승인 무관),
   * 차감 = 지각뿐(D-R32 — 최초 제출 기준), 원천징수 = 3%·10% 각각 절사(D-15).
   * Kinder·그룹·진단 «가산»은 덱 어휘일 뿐 결정·저장처가 없어 **배선하지 않는다** —
   * 단일 시급 × 그 수업일 시급(D8 이력) 정수 절사만 계산한다 (teacherC22 원장 경계).
   */
  async history(teacherId: number, month?: string): Promise<TeacherHistoryDto> {
    const today = todayKst();
    const nowMin = nowMinKst();
    const ym = month ?? today.slice(0, 7);
    const first = `${ym}-01`;

    const rows = await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
              s.kind_key, s.sub_key, s.mode, s.title,
              COALESCE(r.state::text,'none') AS rep_state,
              to_char(r.submitted_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS submitted_at,
              (SELECT string_agg(st.name, ', ' ORDER BY st.name)
                 FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                WHERE ss.ser_id = o.ser_id) AS students,
              (SELECT COUNT(*)::int FROM ser_stu ss WHERE ss.ser_id = o.ser_id) AS student_count,
              w.rate AS wage_rate
         FROM ser_occ o
         JOIN ser s      ON s.id = o.ser_id
         LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         LEFT JOIN LATERAL (
                SELECT rate FROM wage
                 WHERE staff_id = $1 AND from_date <= o.on_date
                 ORDER BY from_date DESC LIMIT 1
              ) w ON true
        WHERE ${TEACHER_OF} = $1
          AND o.on_date >= $2::date
          AND o.on_date < $2::date + interval '1 month'
        ORDER BY o.on_date DESC, start_min`,
      [teacherId, first],
    );

    const written = new Set(REPORT_WRITTEN_DB as readonly string[]);
    /** 시급×분 — 항상 정수 절사. 60분 격자 밖 길이도 원 단위가 흔들리지 않게 한 번만 버린다. */
    const payOf = (rate: number, min: number): number => Math.floor((rate * min) / 60);

    const lessons: TeacherHistoryLessonDto[] = [];
    const agg = {
      doneCount: 0, doneMinutes: 0, writtenCount: 0, writtenMinutes: 0,
      unwrittenCount: 0, unwrittenMinutes: 0, gross: 0, lateCut: 0,
      unwrittenAmount: 0, remainingCount: 0, remainingMinutes: 0, remainingAmount: 0,
    };

    for (const r of rows) {
      const onDate = String(r.on_date);
      const startMin = Number(r.start_min);
      const durMin = Number(r.dur_min);
      const canceled = Boolean(r.canceled);
      const repState = String(r.rep_state);
      const submittedAt = (r.submitted_at as string) ?? null;
      const rate = r.wage_rate === null || r.wage_rate === undefined ? null : Number(r.wage_rate);

      const s: SessionLike = { date: onDate, startMin, durationMin: durMin, canceled, submittedAt };
      const ended = minutesSinceEnd(s, today, nowMin) > 0;
      const isWritten = !canceled && written.has(repState);
      const isUnwritten = !canceled && ended && !isWritten;

      let pay: number | null = null;
      let lateCut: number | null = null;
      let penaltyIfNow: number | null = null;
      if (isWritten && rate !== null) {
        pay = payOf(rate, durMin);
        lateCut = latePenalty(s);
        agg.writtenCount += 1; agg.writtenMinutes += durMin;
        agg.gross += pay; agg.lateCut += lateCut;
      } else if (isUnwritten) {
        const after = minutesSinceEnd(s, today, nowMin);
        penaltyIfNow = tierFor(after).amount;
        agg.unwrittenCount += 1; agg.unwrittenMinutes += durMin;
        if (rate !== null) agg.unwrittenAmount += payOf(rate, durMin);
      } else if (!canceled && !ended) {
        agg.remainingCount += 1; agg.remainingMinutes += durMin;
        if (rate !== null) agg.remainingAmount += payOf(rate, durMin);
      }
      if (!canceled && ended) { agg.doneCount += 1; agg.doneMinutes += durMin; }

      lessons.push({
        serId: Number(r.ser_id), onDate, startMin, durMin,
        kindKey: String(r.kind_key), subKey: (r.sub_key as string) ?? null,
        mode: r.mode === 'online' ? 'online' : 'offline',
        title: (r.title as string) ?? null,
        students: (r.students as string) ?? null,
        studentCount: Number(r.student_count ?? 0),
        repState, canceled, submittedAt, pay, lateCut, penaltyIfNow,
      });
    }

    const [me] = await this.q(
      `SELECT w.rate AS wage_rate, to_char(w.from_date,'YYYY-MM-DD') AS wage_from
         FROM staff s
         LEFT JOIN LATERAL (
                SELECT rate, from_date FROM wage
                 WHERE staff_id = s.id AND from_date <= $2::date
                 ORDER BY from_date DESC LIMIT 1
              ) w ON true
        WHERE s.id = $1`,
      [teacherId, today],
    );

    // 확정 payout 행이 있으면 그 저장값이 정본이다 — 화면 계산과 어긋나면 저장값이 이긴다.
    const [po] = await this.q(
      `SELECT hours, gross, late_rep_cut, income_tax, local_tax, net, state
         FROM payout WHERE staff_id = $1 AND year_month = $2`,
      [teacherId, ym],
    );

    const base = agg.gross - agg.lateCut;
    const tax = withholding(base);
    const settlement = po
      ? {
          yearMonth: ym, confirmed: true, state: String(po.state),
          writtenMinutes: Math.round(Number(po.hours) * 60),
          gross: Number(po.gross), lateCut: Number(po.late_rep_cut),
          incomeTax: Number(po.income_tax), localTax: Number(po.local_tax), net: Number(po.net),
          unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes, unwrittenAmount: agg.unwrittenAmount,
          remainingCount: agg.remainingCount, remainingMinutes: agg.remainingMinutes, remainingAmount: agg.remainingAmount,
        }
      : {
          yearMonth: ym, confirmed: false, state: null,
          writtenMinutes: agg.writtenMinutes,
          gross: agg.gross, lateCut: agg.lateCut,
          incomeTax: tax.income, localTax: tax.local, net: base - tax.total,
          unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes, unwrittenAmount: agg.unwrittenAmount,
          remainingCount: agg.remainingCount, remainingMinutes: agg.remainingMinutes, remainingAmount: agg.remainingAmount,
        };

    return {
      month: ym,
      stats: {
        doneCount: agg.doneCount, doneMinutes: agg.doneMinutes,
        writtenCount: agg.writtenCount, writtenMinutes: agg.writtenMinutes,
        unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes,
      },
      wageRate: me?.wage_rate === null || me?.wage_rate === undefined ? null : Number(me.wage_rate),
      wageFrom: (me?.wage_from as string) ?? null,
      lessons,
      settlement,
    };
  }
}
