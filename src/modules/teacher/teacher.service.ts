/** @file-guide
 * 목적: teacher.service.ts — TeacherService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ser } from '../../entities';
import {
  REPORT_UNWRITTEN_CANDIDATE_DB, REPORT_WRITTEN_DB,
  latePenalty, minutesSinceEnd, tierFor, withholding, type SessionLike,
} from '../../lib/rules';
import { KST, addDays, isIsoDate, nowMinKst, todayKst } from '../../lib/kst';
import { REQ_TYPE_LABEL, labelOf } from '../../lib/approval';
import type {
  TeacherGuideStudentDto, TeacherGuidesDto,
  TeacherUnavBlockDto, TeacherUnavCreateDto, TeacherUnavDto,
  TeacherHistoryDto, TeacherHistoryLessonDto, TeacherHomeDto, TeacherLessonDto,
  TeacherSuggestionCreateDto, TeacherSuggestionDto, TeacherSuggestionsDto,
  TeacherSettingReqCreateDto, TeacherSettingRequestDto, TeacherSettingsDto,
} from './teacher.dto';

/** 건의 월 한도 (V26 §7 확정 — 서버가 센다, SUGGESTION_QUOTA_EXCEEDED) */
const SUGGESTION_MONTHLY_LIMIT = 3;
/** created_at(timestamptz) → KST 달력일 — 쿼터·표기 공용 */
const KST_DATE = "(created_at AT TIME ZONE 'Asia/Seoul')::date";
/** 불가 시간 (N-20 채택 2026-09-12 §4-17) — 등록 대상 **날짜별 7일 전 마감**. 격자 창은 원본 §15/16 의 08:00~23:00. */
const UNAV_DEADLINE_DAYS = 7;
const UNAV_MIN_START = 8 * 60;
const UNAV_MAX_END = 23 * 60;
/** 두 KST 달력일 사이 일수 (b − a) */
const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** 0=일 … 6=토 */
const dowOf = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();

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
      settings: await this.settings(teacherId, today, me),
    };
  }

  /* ══ 내 설정 (강사 덱 §8 우측 레일) ═══════════════════════════════════
     원문: 「시간대 / 기본 시급, 각각 변경 요청 버튼, **관리자 승인 후 적용**,
     시급은 **한 달에 한 번 신청 가능**」. 적용은 관리자가 하고 강사는 올리기만 한다. */

  /** 시급을 다시 신청할 수 있는 날 — 마지막 신청일 + 1개월 (원문 「한 달에 한 번」) */
  private static wageAskableOn(lastAskedOn: string | null): string | null {
    if (!lastAskedOn) return null;
    const [y, m, d] = lastAskedOn.split('-').map(Number);
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  }

  private async settings(teacherId: number, today: string, me: R | undefined): Promise<TeacherSettingsDto> {
    const timezones = (await this.q(`SELECT tz, name FROM tzg ORDER BY id`))
      .map((r) => ({ tz: String(r.tz), name: String(r.name) }));

    const rows = await this.q(
      `SELECT id, req_type, payload, state, reject_reason,
              to_char(created_at AT TIME ZONE '${KST}','YYYY-MM-DD') AS created_on
         FROM req
        WHERE staff_id = $1 AND req_type IN ('wage_change','tz_change')
        ORDER BY created_at DESC, id DESC
        LIMIT 10`,
      [teacherId],
    );
    const requests: TeacherSettingRequestDto[] = rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const asked = r.req_type === 'wage_change'
        ? (payload.to === undefined ? null : `${Number(payload.to).toLocaleString('ko-KR')}원/시간`)
        : ((payload.tz as string) ?? null);
      return {
        id: Number(r.id), reqType: String(r.req_type),
        label: labelOf(REQ_TYPE_LABEL, String(r.req_type)),
        asked, state: String(r.state), createdOn: String(r.created_on),
        rejectReason: (r.reject_reason as string) ?? null,
      };
    });

    // 「한 달에 한 번」은 **결과와 무관하다** — 반려됐어도 한 달은 기다린다(원문 그대로).
    const lastWage = requests.find((r) => r.reqType === 'wage_change')?.createdOn ?? null;
    const wageAskableOn = TeacherService.wageAskableOn(lastWage);
    const tzPending = requests.some((r) => r.reqType === 'tz_change' && r.state === 'pending');

    return {
      name: String(me?.name ?? ''),
      timezone: String(me?.tz ?? 'Asia/Seoul'),
      wageRate: me?.wage_rate === null || me?.wage_rate === undefined ? null : Number(me.wage_rate),
      wageFrom: (me?.wage_from as string) ?? null,
      timezones,
      requests,
      canAskWage: wageAskableOn === null || wageAskableOn <= today,
      wageAskableOn: wageAskableOn !== null && wageAskableOn > today ? wageAskableOn : null,
      canAskTz: !tzPending,
    };
  }

  /**
   * 내 설정 변경 요청을 올린다 — **적용하지 않는다.** 관리자가 승인해야 바뀐다 (덱 §8).
   *
   * 시급은 **한 달에 한 번**이다(원문). 승인/반려 결과와 무관하게 마지막 **신청일** 기준으로 센다 —
   * 반려됐다고 그날 다시 올릴 수 있으면 「한 달에 한 번」이 아니다.
   * 시간대는 진행 중인 건이 있으면 또 올리지 않는다(같은 것을 두 번 처리하게 된다).
   */
  async createSettingRequest(teacherId: number, dto: TeacherSettingReqCreateDto): Promise<TeacherSettingRequestDto> {
    const today = todayKst();
    const [me] = await this.q(`SELECT id, tz FROM staff WHERE id = $1`, [teacherId]);
    if (!me) throw new NotFoundException('구성원을 찾을 수 없습니다');

    let payload: Record<string, unknown>;
    if (dto.reqType === 'wage_change') {
      if (dto.rate === undefined) {
        throw new BadRequestException({ code: 'RATE_REQUIRED', message: '바라는 시급을 넣어 주세요' });
      }
      const [last] = await this.q<{ created_on: string }>(
        `SELECT to_char(created_at AT TIME ZONE '${KST}','YYYY-MM-DD') AS created_on
           FROM req WHERE staff_id = $1 AND req_type = 'wage_change'
          ORDER BY created_at DESC LIMIT 1`,
        [teacherId],
      );
      const askableOn = TeacherService.wageAskableOn(last?.created_on ?? null);
      if (askableOn !== null && askableOn > today) {
        throw new ConflictException({
          code: 'WAGE_REQ_MONTHLY_QUOTA',
          message: `시급 변경은 한 달에 한 번 신청할 수 있습니다 — ${askableOn}부터 다시 됩니다`,
        });
      }
      const [w] = await this.q<{ rate: number }>(
        `SELECT rate FROM wage WHERE staff_id = $1 AND from_date <= $2::date ORDER BY from_date DESC LIMIT 1`,
        [teacherId, today],
      );
      payload = { from: w?.rate === undefined ? null : Number(w.rate), to: dto.rate };
    } else {
      if (!dto.timezone) {
        throw new BadRequestException({ code: 'TZ_REQUIRED', message: '바라는 시간대를 골라 주세요' });
      }
      const [tz] = await this.q(`SELECT tz FROM tzg WHERE tz = $1`, [dto.timezone]);
      if (!tz) {
        throw new BadRequestException({ code: 'TZ_UNKNOWN', message: '고를 수 없는 시간대입니다' });
      }
      if (dto.timezone === String(me.tz)) {
        throw new ConflictException({ code: 'TZ_SAME', message: '지금 쓰고 있는 시간대입니다' });
      }
      const [open] = await this.q(
        `SELECT id FROM req WHERE staff_id = $1 AND req_type = 'tz_change' AND state = 'pending' LIMIT 1`,
        [teacherId],
      );
      if (open) {
        throw new ConflictException({ code: 'REQ_PENDING', message: '이미 올린 시간대 변경 요청이 처리 중입니다' });
      }
      payload = { from: String(me.tz), tz: dto.timezone };
    }
    if (dto.reason?.trim()) payload.reason = dto.reason.trim();

    // 상태는 적지 않는다 — 표의 기본값('pending')이 낱말의 출처다 (migration 1756700000000)
    const inserted = await this.q(
      `INSERT INTO req (staff_id, req_type, payload) VALUES ($1, $2, $3::jsonb)
       RETURNING id, req_type, payload, state, reject_reason,
                 to_char(created_at AT TIME ZONE '${KST}','YYYY-MM-DD') AS created_on`,
      [teacherId, dto.reqType, JSON.stringify(payload)],
    );
    const r = inserted[0];
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return {
      id: Number(r.id), reqType: String(r.req_type),
      label: labelOf(REQ_TYPE_LABEL, String(r.req_type)),
      asked: dto.reqType === 'wage_change'
        ? `${Number(p.to).toLocaleString('ko-KR')}원/시간`
        : String(p.tz ?? ''),
      state: String(r.state), createdOn: String(r.created_on),
      rejectReason: null,
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

  /**
   * 수업 안내 — 이번 주(월~일) 담당 학생과 준비 정보 (강사 덱 §10~13).
   *
   * 학생 스타일 영역별 평가·바 차트는 구조화 저장처가 없어 **싣지 않는다**
   * (조사 메모 TBO-49 §6 — 결정 요청 대상). 진단은 diag 최신 1건의 텍스트 그대로.
   */
  async guides(teacherId: number, week?: string): Promise<TeacherGuidesDto> {
    const anchor = week ?? todayKst();

    const rows = await this.q(
      `WITH wk AS (
         SELECT date_trunc('week', $2::date)::date AS f,
                date_trunc('week', $2::date)::date + 6 AS t
       )
       SELECT st.id AS student_id, st.name, st.grade, st.school, st.target_exam,
              st.guidance, st.lang,
              o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
              s.sub_key, s.title
         FROM ser_occ o
         JOIN ser s      ON s.id = o.ser_id
         JOIN ser_stu ss ON ss.ser_id = o.ser_id
         JOIN stu st     ON st.id = ss.student_id
         CROSS JOIN wk
        WHERE ${TEACHER_OF} = $1
          AND NOT o.canceled
          AND o.on_date BETWEEN wk.f AND wk.t
        ORDER BY o.on_date, start_min, st.name`,
      [teacherId, anchor],
    );

    const byStudent = new Map<number, TeacherGuideStudentDto>();
    for (const r of rows) {
      const id = Number(r.student_id);
      let s = byStudent.get(id);
      if (!s) {
        s = {
          studentId: id,
          name: String(r.name),
          grade: (r.grade as string) ?? null,
          school: (r.school as string) ?? null,
          targetExam: (r.target_exam as string) ?? null,
          guidance: (r.guidance as string) ?? null,
          lang: (r.lang as string) ?? null,
          weekCount: 0,
          lessons: [],
          books: [],
          diag: null,
        };
        byStudent.set(id, s);
      }
      s.weekCount += 1;
      s.lessons.push({
        onDate: String(r.on_date), startMin: Number(r.start_min), durMin: Number(r.dur_min),
        subKey: (r.sub_key as string) ?? null, title: (r.title as string) ?? null,
      });
    }

    const ids = [...byStudent.keys()];
    if (ids.length > 0) {
      const books = await this.q(
        `SELECT i.id AS issue_id, i.student_id, l.code, l.title, l.sub_key, l.level, l.se_te,
                to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
                to_char(i.returned_on,'YYYY-MM-DD') AS returned_on
           FROM issue i JOIN lib l ON l.id = i.lib_id
          WHERE i.student_id = ANY($1)
          ORDER BY (i.returned_on IS NOT NULL), i.issued_on DESC`,
        [ids],
      );
      for (const b of books) {
        byStudent.get(Number(b.student_id))?.books.push({
          issueId: Number(b.issue_id), code: String(b.code), title: String(b.title),
          subKey: (b.sub_key as string) ?? null, level: (b.level as string) ?? null,
          seTe: String(b.se_te ?? 'SE'), issuedOn: String(b.issued_on),
          returnedOn: (b.returned_on as string) ?? null,
        });
      }

      const diags = await this.q(
        `SELECT DISTINCT ON (d.student_id)
                d.student_id, to_char(d.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS on_date,
                d.level_summary, d.strengths, d.weaknesses
           FROM diag d
          WHERE d.student_id = ANY($1)
          ORDER BY d.student_id, d.created_at DESC`,
        [ids],
      );
      for (const d of diags) {
        const s = byStudent.get(Number(d.student_id));
        if (s) {
          s.diag = {
            onDate: (d.on_date as string) ?? null,
            levelSummary: String(d.level_summary),
            strengths: (d.strengths as string) ?? null,
            weaknesses: (d.weaknesses as string) ?? null,
          };
        }
      }
    }

    const [wk] = await this.q(
      `SELECT to_char(date_trunc('week', $1::date)::date, 'YYYY-MM-DD') AS f,
              to_char(date_trunc('week', $1::date)::date + 6, 'YYYY-MM-DD') AS t`,
      [anchor],
    );
    return {
      weekFrom: String(wk?.f ?? anchor),
      weekTo: String(wk?.t ?? anchor),
      students: [...byStudent.values()],
    };
  }

  /** 이달(KST) 등록 수 — 쿼터 판정과 응답이 같은 문장을 쓴다. */
  private async suggestionUsed(teacherId: number, today: string): Promise<number> {
    const [row] = await this.q(
      `SELECT COUNT(*)::int AS n FROM suggestion
        WHERE staff_id = $1
          AND ${KST_DATE} >= date_trunc('month', $2::date)::date
          AND ${KST_DATE} <  (date_trunc('month', $2::date) + interval '1 month')::date`,
      [teacherId, today],
    );
    return Number(row?.n ?? 0);
  }

  private suggestionRow(r: R): TeacherSuggestionDto {
    return {
      id: Number(r.id),
      category: String(r.category),
      body: String(r.body),
      state: String(r.state),
      createdOn: String(r.created_on),
      reply: (r.reply as string) ?? null,
      replyBy: (r.reply_by_name as string) ?? null,
      replyOn: (r.reply_on as string) ?? null,
    };
  }

  /** 건의 사항 — 내가 보낸 것 + 이달 쿼터 (덱 §33~34 · 월 3회는 서버가 센다). */
  async suggestions(teacherId: number): Promise<TeacherSuggestionsDto> {
    const today = todayKst();
    const used = await this.suggestionUsed(teacherId, today);
    const items = await this.q(
      `SELECT g.id, g.category::text AS category, g.body, g.state::text AS state,
              to_char((g.created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS created_on,
              g.reply, st.name AS reply_by_name,
              to_char((g.reply_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS reply_on
         FROM suggestion g
         LEFT JOIN staff st ON st.id = g.reply_by
        WHERE g.staff_id = $1
        ORDER BY g.created_at DESC
        LIMIT 100`,
      [teacherId],
    );
    return {
      yearMonth: today.slice(0, 7),
      used,
      limit: SUGGESTION_MONTHLY_LIMIT,
      remaining: Math.max(0, SUGGESTION_MONTHLY_LIMIT - used),
      canPost: used < SUGGESTION_MONTHLY_LIMIT,
      items: items.map((r) => this.suggestionRow(r)),
    };
  }

  /**
   * 건의 등록 — 확정 쓰기 1호. 쿼터 판정과 삽입을 **한 문장**으로 묶어
   * 동시 요청이 와도 한도를 넘겨 들어가지 않는다 (등록 차단: SUGGESTION_QUOTA_EXCEEDED).
   */
  async createSuggestion(teacherId: number, dto: TeacherSuggestionCreateDto): Promise<TeacherSuggestionDto> {
    const today = todayKst();
    const body = dto.body.trim();
    if (!body) throw new ConflictException({ code: 'EMPTY_BODY', message: '내용을 적어 주세요' });

    // 잠금 + 판정 + 삽입을 한 트랜잭션으로 — 동시 요청 두 개가 같은 「2/3」을 보고 둘 다 들어가는 창을 닫는다
    const inserted = await this.anyRepo.manager.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext('suggestion-quota'), $1::int)`, [teacherId]);
      return em.query(
        `INSERT INTO suggestion (staff_id, category, body)
         SELECT $1, $2::sug_cat_t, $3
          WHERE (SELECT COUNT(*) FROM suggestion
                  WHERE staff_id = $1
                    AND ${KST_DATE} >= date_trunc('month', $4::date)::date
                    AND ${KST_DATE} <  (date_trunc('month', $4::date) + interval '1 month')::date)
                < ${SUGGESTION_MONTHLY_LIMIT}
         RETURNING id, category::text AS category, body, state::text AS state,
                   to_char((created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS created_on,
                   reply, NULL AS reply_by_name, NULL AS reply_on`,
        [teacherId, dto.category, body, today],
      ) as Promise<R[]>;
    });
    const row = inserted[0];
    if (!row) {
      throw new ConflictException({
        code: 'SUGGESTION_QUOTA_EXCEEDED',
        message: `이번 달 건의 ${SUGGESTION_MONTHLY_LIMIT}회를 모두 사용했습니다. 다음 달에 다시 남길 수 있습니다`,
      });
    }
    return this.suggestionRow(row);
  }

  /* ══ 불가 시간 — 원본 §15/16 · N-20 채택(날짜별 7일 전 마감) ══ */

  private unavBlockRow(r: R, openFromRaw: string): TeacherUnavBlockDto {
    const onDate = String(r.on_date);
    return {
      id: Number(r.id), onDate, dow: dowOf(onDate),
      startMin: Number(r.start_min), endMin: Number(r.end_min), reason: String(r.reason),
      canDelete: onDate >= openFromRaw,
    };
  }

  /**
   * 2주 격자 메타 + 내 등록. 회차는 입사일 + 14k (원본 §15 — 표시/묶음용, 판정은 날짜).
   * openFrom = max(회차 시작, 오늘+7) — 원본 캡처의 「잠김 8일 · 열림 6일」이 이 식에서 나온다.
   */
  async unavailable(teacherId: number, anchor?: string): Promise<TeacherUnavDto> {
    const today = todayKst();
    const [me] = await this.q<{ hired_on: string | null }>(
      `SELECT hired_on::text AS hired_on FROM staff WHERE id = $1`, [teacherId]);
    if (!me?.hired_on) {
      throw new ConflictException({ code: 'NO_HIRED_ON', message: '입사일이 없어 2주 회차를 계산할 수 없습니다 — 관리자에게 문의해 주세요' });
    }
    const hiredOn = me.hired_on;
    const at = anchor && isIsoDate(anchor) ? anchor : today;
    const k = Math.max(0, Math.floor(diffDays(hiredOn, at) / 14));
    const from = addDays(hiredOn, k * 14);
    const to = addDays(from, 13);
    const openFromRaw = addDays(today, UNAV_DEADLINE_DAYS);
    const openFrom = openFromRaw < from ? from : openFromRaw;
    const lockedDays = Math.min(14, Math.max(0, diffDays(from, openFrom)));
    const rows = await this.q<R>(
      `SELECT id, on_date::text AS on_date, start_min, end_min, reason
         FROM unav
        WHERE staff_id = $1 AND on_date BETWEEN $2 AND $3
        ORDER BY on_date, start_min`, [teacherId, from, to]);
    return {
      cycle: { index: k + 1, from, to, hiredOn },
      today, openFrom,
      lockedDays, openDays: 14 - lockedDays,
      blocks: rows.map((r) => this.unavBlockRow(r, openFromRaw)),
    };
  }

  /**
   * 등록 — 마감(날짜별 7일 전)과 본인 겹침을 서버가 판정한다. 겹침 판정과 삽입은
   * advisory lock 트랜잭션의 guarded INSERT 한 문장 — 동시 등록이 같은 빈칸을 두 번 차지하지 못한다.
   * 새 쓰기는 cycle 을 저장하지 않는다(§4-17 — 회차는 표시용 파생), dow 는 날짜에서 파생해 저장.
   */
  async createUnavailable(teacherId: number, dto: TeacherUnavCreateDto): Promise<TeacherUnavBlockDto> {
    const today = todayKst();
    if (!isIsoDate(dto.onDate)) {
      throw new ConflictException({ code: 'INVALID_DATE', message: '실재하는 날짜가 아닙니다' });
    }
    if (dto.endMin <= dto.startMin) {
      throw new ConflictException({ code: 'TIME_RANGE', message: '끝 시각은 시작 시각보다 커야 합니다' });
    }
    if (dto.startMin < UNAV_MIN_START || dto.endMin > UNAV_MAX_END) {
      throw new ConflictException({ code: 'TIME_RANGE', message: '불가 시간은 08:00~23:00 안에서 등록합니다' });
    }
    const openFromRaw = addDays(today, UNAV_DEADLINE_DAYS);
    if (dto.onDate < openFromRaw) {
      throw new ConflictException({
        code: 'UNAV_DEADLINE',
        message: '등록은 날짜별 7일 전까지만 가능합니다. 1주 안의 사정은 강사 단톡방에 올려 주세요 — 관리자가 확인하고 직접 조정합니다',
      });
    }
    const reason = dto.reason.trim();
    if (!reason) throw new ConflictException({ code: 'EMPTY_REASON', message: '사유를 적어 주세요' });

    const inserted = await this.anyRepo.manager.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext('unav-write'), $1::int)`, [teacherId]);
      return em.query(
        `INSERT INTO unav (staff_id, on_date, dow, start_min, end_min, reason)
         SELECT $1, $2::date, $3, $4, $5, $6
          WHERE NOT EXISTS (
                SELECT 1 FROM unav
                 WHERE staff_id = $1 AND on_date = $2::date AND start_min < $5 AND end_min > $4)
         RETURNING id, on_date::text AS on_date, start_min, end_min, reason`,
        [teacherId, dto.onDate, dowOf(dto.onDate), dto.startMin, dto.endMin, reason],
      ) as Promise<R[]>;
    });
    if (inserted.length === 0) {
      throw new ConflictException({ code: 'UNAV_OVERLAP', message: '이미 등록한 시간과 겹칩니다' });
    }
    return this.unavBlockRow(inserted[0], openFromRaw);
  }

  /** 삭제 — 본인 행이면서 아직 열린 날짜(오늘+7 이후)만. 마감분·legacy(날짜 미상)는 관리자 조정 대상. */
  async deleteUnavailable(teacherId: number, id: number): Promise<{ ok: true }> {
    const [row] = await this.q<{ id: string | number; on_date: string | null }>(
      `SELECT id, on_date::text AS on_date FROM unav WHERE id = $1 AND staff_id = $2`, [id, teacherId]);
    if (!row) throw new NotFoundException('등록을 찾을 수 없습니다');
    const openFromRaw = addDays(todayKst(), UNAV_DEADLINE_DAYS);
    if (!row.on_date || row.on_date < openFromRaw) {
      throw new ConflictException({
        code: 'UNAV_LOCKED',
        message: '마감된 날짜의 등록은 여기서 지울 수 없습니다 — 관리자에게 문의해 주세요',
      });
    }
    await this.q(`DELETE FROM unav WHERE id = $1 AND staff_id = $2`, [id, teacherId]);
    return { ok: true };
  }
}
