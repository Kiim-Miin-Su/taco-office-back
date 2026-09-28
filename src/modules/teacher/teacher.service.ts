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
  ATTENDANCE_CANCEL_REASON_LABEL, REPORT_UNWRITTEN_CANDIDATE_DB, payoutConfirmed, type AttendanceCancelReason,
} from '../../lib/rules';
import { KST, addDays, isIsoDate, nowMinKst, todayKst } from '../../lib/kst';
import {
  BONUS_D1_DEFAULTS, BONUS_KIND_HINT, BONUS_KIND_LABEL, KINDER_MARKER_EXISTS, KINDER_NOT_APPLIED,
  loadBonusRules, payoutBreakdown, payoutSettleLabel, payoutSheet,
} from '../../lib/payout-sheet';
import { effectiveModeOf, kstAt, serStuOn } from '../../lib/sql';
import { REQ_TYPE_LABEL, labelOf, reqAsked, reqAskedLine } from '../../lib/approval';
import { NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory } from '../../lib/noti';
import { wageRateAt } from '../../lib/wage';
import type {
  TeacherDiagCreateDto, TeacherGuideDiagDto, TeacherGuideStudentDto, TeacherGuidesDto,
  TeacherUnavBlockDto, TeacherUnavCreateDto, TeacherUnavDto,
  TeacherHistoryDto, TeacherHomeDto, TeacherLessonDto,
  TeacherSuggestionCreateDto, TeacherSuggestionDto, TeacherSuggestionsDto,
  TeacherSettingReqCreateDto, TeacherSettingRequestDto, TeacherSettingsDto,
  TeacherNotiDto, TeacherShellDto, TeacherGpaServiceDto, TeacherGpaOccurrenceDto, TeacherGpaRequestOptionsDto,
} from './teacher.dto';
import { SUGGESTION_MONTHLY_LIMIT, UNAV_DEADLINE_DAYS } from '../../lib/teacher-policy';
import { audit } from '../../lib/audit';
import { bookLevelShown } from '../../lib/book';

/** created_at(timestamptz) → KST 달력일 — 쿼터·표기 공용 */
const KST_DATE = "(created_at AT TIME ZONE 'Asia/Seoul')::date";
/* 건의 월 한도 · 불가 시간 마감(N-20 · 날짜별 7일 전)은 lib/teacher-policy 한 곳 — 강사 정책 띠가 같은 숫자를 읽는다.
   격자 창은 원본 §15/16 의 08:00~23:00. */
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

/**
 * 「열린 수업」 — 휴강(ser_occ.canceled)도 **출결 취소**(att.result = 'canceled')도 아닌 회차. `LEFT JOIN att a` 와 같이 쓴다.
 * 홈 hero·이번 주 칩·「리포트 미작성」이 이 한 줄을 쓴다 — 캘린더 머리(teacherSchedule 의 countsForPay)와
 * 리포트 목록(REPORT_CANCELED_SQL)이 이미 출결 취소를 빼고 세므로, 여기만 빠뜨리면 같은 강사의 같은 날이 화면마다 다른 수가 된다(N-19).
 */
const HELD = `NOT o.canceled AND COALESCE(a.result, 'completed') <> 'canceled'`;
const ATT_JOIN = 'LEFT JOIN att a ON a.ser_id = o.ser_id AND a.on_date = o.on_date';
/**
 * 리포트 대상인 종류인가(kind.rep) — `LEFT JOIN rep r` 뒤에 붙인다. 리포트 목록(effectiveRepStateFromEnded)은
 * 대상이 아닌 종류(자습·회의)를 na 로 읽는데 홈은 이 판정 없이 「rep 행 없음 = 미작성」으로 세고 있었다(wave 6 재현).
 * 리포트 쪽과 같은 키(COALESCE(r.kind_key, s.kind_key))로 읽는다.
 */
const KIND_JOIN = 'JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)';

/**
 * 머리줄 시간대 표기 — 강사 덱 머리줄 「◷ Seoul · UTC+9」 · 메뉴 사용자 칸 「시간대 Seoul UTC+9」.
 * 도시는 IANA 이름의 끝 마디, 차이는 **그 시각**의 UTC 차이다(서머타임이 있는 곳은 철마다 바뀐다).
 * 화면이 `Asia/Seoul → Seoul UTC+9` 같은 표를 따로 들면 시간대를 더할 때 한쪽이 빠진다 — 그래서 서버가 짓는다.
 * 런타임이 모르는 이름이면 이름을 그대로 돌려준다(머리줄이 깨지지 않게).
 */
export function tzLabelOf(tz: string, at: Date = new Date()): string {
  let offset: string | undefined;
  try {
    offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((part) => part.type === 'timeZoneName')?.value;
  } catch {
    return tz;
  }
  if (!offset) return tz;
  const city = (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
  // Intl 은 「GMT+9」 · 차이가 없으면 「GMT」 — 원문 낱말은 UTC 다
  const utc = offset === 'GMT' ? 'UTC+0' : offset.replace('GMT', 'UTC');
  return `${city} · ${utc}`;
}

@Injectable()
export class TeacherService {
  constructor(@InjectRepository(Ser) private readonly anyRepo: Repository<Ser>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /**
   * 강사 머리줄 — 시간대 · 오늘 시급 · **내게 온** 알림 (강사 덱 머리줄 🔔 · N-26 을 D-R44 로 좁게 읽음).
   * 알림은 서랍 §16 과 같은 NOTI 행·같은 창(NOTI_WINDOW_DAYS)·같은 종류 낱말을 쓰되 `to_id = 나` 만 싣는다 —
   * 관리자 서랍의 다른 칸(승인 대기함·구성원·줌…)은 강사에게 짓지 않는다(원문 강사 화면 7개에 없다).
   * 읽음 처리는 서랍의 본인 한정 경로(`PATCH /drawer/notis/:id/read` · `read-all`)를 그대로 쓴다.
   */
  async shell(teacherId: number): Promise<TeacherShellDto> {
    const [me] = await this.q(`SELECT tz FROM staff WHERE id = $1`, [teacherId]);
    const timezone = String(me?.tz ?? KST);
    // 시급은 회차·히스토리와 같은 정의(오늘 이하의 마지막 줄) — lib/wage 한 곳
    const wageRate = await wageRateAt(this.anyRepo, teacherId, todayKst());
    const notis = (await this.q(
      `SELECT n.id, n.title, n.body, n.link, n.category, n.read_at, f.name AS from_name,
              ${kstAt('n.created_at')} AS at
         FROM noti n LEFT JOIN staff f ON f.id = n.from_id
        WHERE n.to_id = $1
          AND n.created_at >= now() - make_interval(days => $2::int)
        ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC, n.id DESC`,
      [teacherId, NOTI_WINDOW_DAYS],
    )).map((r): TeacherNotiDto => {
      const link = (r.link as string | null) ?? null;
      return {
        id: Number(r.id),
        title: (r.title as string | null) ?? null,
        body: String(r.body),
        link,
        read: r.read_at !== null,
        at: String(r.at),
        categoryLabel: NOTI_CATEGORY_LABEL[notiCategory(r.category as string | null, link)],
        fromName: (r.from_name as string | null) ?? null,
      };
    });
    return {
      timezone,
      tzLabel: tzLabelOf(timezone),
      wageRate,
      notis,
      unread: notis.filter((noti) => !noti.read).length,
      notiWindowDays: NOTI_WINDOW_DAYS,
    };
  }

  /** 강사 홈 — 서버가 teacherId 로 고정한다. 화면은 거르지 않는다 (D-R39). */
  async home(teacherId: number): Promise<TeacherHomeDto> {
    const today = todayKst();
    const candidates = [...REPORT_UNWRITTEN_CANDIDATE_DB];

    const lessons = (await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, o.canceled,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
              -- 회차의 실제 방식 — 그 회차만 바꾼 예외(exc.mode)가 이긴다 (N-56 · lib/sql 한 조각)
              s.kind_key, s.sub_key, ${effectiveModeOf('ex', 's')} AS mode, s.title,
              rm.name AS room_name, rm.branch AS room_branch, z.label AS zacc_label,
              COALESCE(r.state::text,'none') AS rep_state,
              (SELECT e.cancel_kind FROM exc e WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date) AS cancel_kind,
              (SELECT string_agg(st.name, ', ' ORDER BY st.name)
                 FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}) AS students
         FROM ser_occ o
         JOIN ser s        ON s.id = o.ser_id
         LEFT JOIN room rm ON rm.id = COALESCE(o.room_id, s.room_id)
         LEFT JOIN zacc z  ON z.id = o.zacc_id
         LEFT JOIN rep r   ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         LEFT JOIN exc ex  ON ex.ser_id = o.ser_id AND ex.on_date = o.on_date
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
      // 휴강 사유는 서버의 낱말이다 (D-R18) — 옛 휴강(사유 없음)은 null 그대로
      cancelKindLabel: r.cancel_kind ? ATTENDANCE_CANCEL_REASON_LABEL[r.cancel_kind as AttendanceCancelReason] ?? null : null,
      repState: String(r.rep_state),
    }));

    // 오늘(hero)과 이번 주(다가오는 수업 칩)를 한 문장에서 센다 — 같은 판정(HELD)이라 두 숫자가 갈리지 않는다
    const [week] = await this.q(
      `SELECT COUNT(*) FILTER (WHERE ${HELD})::int AS lessons,
              COALESCE(SUM(EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)
                       FILTER (WHERE ${HELD}), 0)::int AS minutes,
              COUNT(*) FILTER (WHERE ${HELD} AND k.rep AND upper(o.span) < now()
                                 AND COALESCE(r.state::text,'none') = ANY($3))::int AS unwritten,
              COUNT(*) FILTER (WHERE ${HELD} AND o.on_date = $2::date)::int AS today_lessons,
              COALESCE(SUM(EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)
                       FILTER (WHERE ${HELD} AND o.on_date = $2::date), 0)::int AS today_minutes
         FROM ser_occ o
         JOIN ser s      ON s.id = o.ser_id
         LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         ${KIND_JOIN}
         ${ATT_JOIN}
        WHERE ${TEACHER_OF} = $1
          AND o.on_date BETWEEN date_trunc('week',$2::date)::date
                            AND date_trunc('week',$2::date)::date + 6`,
      [teacherId, today, candidates],
    );

    const [todo] = await this.q(
      `SELECT (SELECT COUNT(*)::int
                 FROM ser_occ o JOIN ser s ON s.id = o.ser_id
                 LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
                 ${KIND_JOIN}
                 ${ATT_JOIN}
                WHERE ${TEACHER_OF} = $1 AND ${HELD} AND k.rep AND upper(o.span) < now()
                  AND COALESCE(r.state::text,'none') = ANY($2)) AS unwritten_reports,
              (SELECT COUNT(*)::int FROM rep WHERE teacher_id = $1 AND state = 'wait') AS waiting_approvals,
              (SELECT COUNT(*)::int FROM chreq WHERE by_id = $1 AND state = 'pending') AS open_change_requests,
              (SELECT COUNT(*)::int FROM req   WHERE staff_id = $1 AND state = 'pending') AS open_staff_requests,
              (SELECT COUNT(*)::int FROM req   WHERE staff_id = $1 AND req_type = 'book_change' AND state = 'pending') AS open_book_changes`,
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
      todaySummary: {
        lessons: Number(week?.today_lessons ?? 0),
        minutes: Number(week?.today_minutes ?? 0),
      },
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
        // 강사 덱 §8 「오늘 할 일」 넷째 줄 「교재 변경 요청 중」 — 서버가 센다 (N-99)
        openBookChanges: Number(todo?.open_book_changes ?? 0),
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
      const asked = reqAsked(String(r.req_type), payload).to;
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
    /** 교재 변경 · GPA 회차 요청은 학생을 **칸으로** 남긴다(§38 가 req.student_id 를 먼저 읽는다 · 이름 스냅숏은 옛 줄의 대체일 뿐) */
    let studentId: number | null = null;
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
    } else if (dto.reqType === 'book_change') {
      const book = await this.bookChangePayload(teacherId, dto);
      studentId = book.studentId;
      payload = book.payload;
    } else if (dto.reqType === 'gpa_request') {
      const gpa = await this.gpaRequestPayload(teacherId, dto);
      studentId = gpa.studentId;
      payload = gpa.payload;
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
    if (dto.reason?.trim() && dto.reqType !== 'book_change') payload.reason = dto.reason.trim();

    // 상태는 적지 않는다 — 표의 기본값('pending')이 낱말의 출처다 (migration 1756700000000)
    const inserted = await this.q(
      `INSERT INTO req (staff_id, req_type, payload, student_id) VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, req_type, payload, state, reject_reason,
                 to_char(created_at AT TIME ZONE '${KST}','YYYY-MM-DD') AS created_on`,
      [teacherId, dto.reqType, JSON.stringify(payload), studentId],
    );
    const r = inserted[0];
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return {
      id: Number(r.id), reqType: String(r.req_type),
      label: labelOf(REQ_TYPE_LABEL, String(r.req_type)),
      // 시급 · 시간대는 「바라는 것」, 교재 변경은 지금 교재, GPA 회차는 그 회차의 날짜 · 시각 — 낱말은 lib/approval 한 곳
      asked: dto.reqType === 'wage_change' || dto.reqType === 'tz_change' ? reqAsked(dto.reqType, p).to : reqAskedLine(dto.reqType, p),
      state: String(r.state), createdOn: String(r.created_on),
      rejectReason: null,
    };
  }

  /** 가르치는 학생인가 — 수업 안내 · 진단과 **같은 판정**(`TEACHER_OF`). 없는 학생과 남의 학생은 같은 404 */
  private async assertMyStudent(teacherId: number, studentId: number): Promise<void> {
    const [mine] = await this.q(
      `SELECT 1 AS ok
         FROM ser_occ o JOIN ser s ON s.id = o.ser_id JOIN ser_stu ss ON ss.ser_id = o.ser_id
        WHERE ss.student_id = $2 AND ${TEACHER_OF} = $1
        LIMIT 1`,
      [teacherId, studentId],
    );
    if (!mine) throw new NotFoundException('내 담당 학생이 아닙니다');
  }

  /**
   * 교재 변경 요청(N-99) — 수업 안내의 교재 행 「변경 요청」. **새 교재를 정하지 않는다**(배부 변경은 관리자가 §38 에서 · 자동 배부 없음).
   * 학생 · 교재 · 사유(필수). 그 학생의 **사용 중인** 교재여야 하고 같은 교재에 열린 요청이 있으면 409 REQ_PENDING.
   * `message` 칸에 사유를 둔다 — §38 강사 요청 칩과 §14 사유 줄이 이미 그 칸을 읽는다(옛 줄과 같은 칸 · 두 벌을 만들지 않는다).
   */
  private async bookChangePayload(
    teacherId: number, dto: TeacherSettingReqCreateDto,
  ): Promise<{ studentId: number; payload: Record<string, unknown> }> {
    if (!dto.studentId || !dto.issueId) {
      throw new BadRequestException({ code: 'BOOK_REQUIRED', message: '어느 학생의 어느 교재인지 골라 주세요' });
    }
    const reason = dto.reason?.trim() ?? '';
    if (!reason) throw new BadRequestException({ code: 'REASON_REQUIRED', message: '바꿔 달라는 까닭을 적어 주세요' });
    await this.assertMyStudent(teacherId, dto.studentId);
    const [issue] = await this.q(
      `SELECT i.id, i.student_id, i.lib_id, i.state, l.title, sb.name AS subject_name, st.name AS student_name
         FROM issue i JOIN lib l ON l.id = i.lib_id
         JOIN stu st ON st.id = i.student_id
         LEFT JOIN sub sb ON sb.key = l.sub_key
        WHERE i.id = $1`,
      [dto.issueId],
    );
    // 다른 학생의 배부는 없는 것과 같은 말로 — 누구에게 무엇이 배부됐는지 흘리지 않는다
    if (!issue || Number(issue.student_id) !== dto.studentId) throw new NotFoundException('그 학생의 교재를 찾을 수 없습니다');
    // 「사용 중」(ok) 교재만 — 반환했거나 아직 배부 전(wait · auto)이면 바꿀 교재가 손에 없다(원문 교재 행의 칩 「사용 중」)
    if (String(issue.state) !== 'ok') {
      throw new ConflictException({ code: 'BOOK_NOT_IN_USE', message: '쓰고 있는 교재만 바꿔 달라고 할 수 있습니다 — 반환했거나 아직 배부 전입니다' });
    }
    const [open] = await this.q(
      `SELECT id FROM req WHERE staff_id = $1 AND req_type = 'book_change' AND state = 'pending'
          AND (payload->>'issueId') = $2::text LIMIT 1`,
      [teacherId, String(dto.issueId)],
    );
    if (open) throw new ConflictException({ code: 'REQ_PENDING', message: '이 교재에 올린 변경 요청이 처리 중입니다' });
    return {
      studentId: dto.studentId,
      payload: {
        issueId: dto.issueId, libId: Number(issue.lib_id), bookTitle: String(issue.title),
        subjectName: (issue.subject_name as string | null) ?? null, studentName: String(issue.student_name), message: reason,
      },
    };
  }

  /**
   * GPA 회차 요청(N-99) — 강사 캘린더의 GPA 회차 → 학생 · 서비스 · 시각(그 회차). 승인하면 그 내용으로 GPA 기록 한 줄(§14).
   * 회차는 **내 GPA 수업**이고 휴강이 아니어야 한다 · 학생은 그 회차 명단 · 서비스는 규정표 · 날짜를 품는 **열린** 사이클이 있어야 한다.
   * 시각은 화면이 보낸 값이 아니라 회차가 그날 놓인 자리(`ser_occ.span`)에서 읽는다 — 옮긴 회차도 그대로 맞는다.
   */
  private async gpaRequestPayload(
    teacherId: number, dto: TeacherSettingReqCreateDto,
  ): Promise<{ studentId: number; payload: Record<string, unknown> }> {
    if (!dto.serId || !dto.onDate || !dto.studentId || !dto.svcKey) {
      throw new BadRequestException({ code: 'GPA_REQUEST_REQUIRED', message: '회차 · 학생 · 서비스를 골라 주세요' });
    }
    const [occ] = await this.q(
      `SELECT o.ser_id, o.canceled, s.kind_key,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min
         FROM ser_occ o JOIN ser s ON s.id = o.ser_id
        WHERE o.ser_id = $2 AND o.on_date = $3::date AND ${TEACHER_OF} = $1`,
      [teacherId, dto.serId, dto.onDate],
    );
    if (!occ) throw new NotFoundException('내 수업의 그 회차를 찾을 수 없습니다');
    if (String(occ.kind_key) !== 'gpa') {
      throw new ConflictException({ code: 'GPA_SER_NOT_GPA', message: 'GPA 수업의 회차만 요청할 수 있습니다' });
    }
    if (occ.canceled === true) throw new ConflictException({ code: 'OCC_CANCELED', message: '휴강한 회차입니다' });
    const [onRoster] = await this.q(
      `SELECT st.name FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
        WHERE ss.ser_id = $1 AND ss.student_id = $2 AND ${serStuOn('ss', '$3::date')}`,
      [dto.serId, dto.studentId, dto.onDate],
    );
    if (!onRoster) throw new NotFoundException('그 회차 명단에 없는 학생입니다');
    const [svc] = await this.q(`SELECT key, name FROM gpasvc WHERE key = $1`, [dto.svcKey]);
    if (!svc) throw new NotFoundException('서비스 규정을 찾을 수 없습니다');
    const [cycle] = await this.q(
      `SELECT id FROM gpa_cycle WHERE from_date <= $1::date AND to_date >= $1::date AND NOT closed LIMIT 1`, [dto.onDate],
    );
    if (!cycle) {
      throw new ConflictException({ code: 'GPA_CYCLE_NONE', message: '그 날짜를 품는 열린 GPA 사이클이 없습니다 — 관리자에게 알려 주세요' });
    }
    const [open] = await this.q(
      `SELECT id FROM req WHERE staff_id = $1 AND req_type = 'gpa_request' AND state = 'pending'
          AND (payload->>'serId') = $2::text AND payload->>'onDate' = $3 AND student_id = $4 AND payload->>'svcKey' = $5 LIMIT 1`,
      [teacherId, String(dto.serId), dto.onDate, dto.studentId, dto.svcKey],
    );
    if (open) throw new ConflictException({ code: 'REQ_PENDING', message: '같은 회차 · 학생 · 서비스로 올린 요청이 처리 중입니다' });
    const startMin = Number(occ.start_min);
    return {
      studentId: dto.studentId,
      payload: {
        serId: dto.serId, onDate: dto.onDate, startMin, endMin: startMin + Number(occ.dur_min),
        svcKey: String(svc.key), svcName: String(svc.name), studentName: String(onRoster.name),
      },
    };
  }

  /**
   * 「GPA 회차 요청」 창 한 벌(N-99) — 서비스 규정표 그대로 + 고를 수 있는 내 GPA 회차.
   * 회차는 `gpaRequestPayload` 가 받는 것과 **같은 판정**으로 고른다: 내 수업(`TEACHER_OF`) · 종류 gpa · 휴강 아님 ·
   * 날짜를 품는 열린 사이클이 있음. 명단은 그날 명단(`serStuOn`)이다. 화면은 이 목록을 거르지 않고 그린다.
   */
  async gpaRequestOptions(teacherId: number): Promise<TeacherGpaRequestOptionsDto> {
    const services = (await this.q(`SELECT key, name, point FROM gpasvc ORDER BY sort NULLS LAST, key`))
      .map((r): TeacherGpaServiceDto => ({ key: String(r.key), name: String(r.name), point: Number(r.point) }));
    const occurrences = (await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)::int AS dur_min,
              s.title, s.sub_key, s.kind_key,
              COALESCE((SELECT json_agg(json_build_object('id', st.id, 'name', st.name) ORDER BY st.name)
                          FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
                         WHERE ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}), '[]'::json) AS students
         FROM ser_occ o
         JOIN ser s ON s.id = o.ser_id
        WHERE ${TEACHER_OF} = $1 AND s.kind_key = 'gpa' AND NOT o.canceled
          AND EXISTS (SELECT 1 FROM gpa_cycle c WHERE c.from_date <= o.on_date AND c.to_date >= o.on_date AND NOT c.closed)
        ORDER BY o.on_date, start_min`,
      [teacherId],
    )).map((r): TeacherGpaOccurrenceDto => {
      const startMin = Number(r.start_min);
      return {
        serId: Number(r.ser_id), onDate: String(r.on_date), startMin, endMin: startMin + Number(r.dur_min),
        title: (r.title as string | null) ?? null, subKey: (r.sub_key as string | null) ?? null, kindKey: String(r.kind_key),
        students: ((r.students as Array<{ id: number | string; name: string }> | null) ?? [])
          .map((st) => ({ id: Number(st.id), name: String(st.name) })),
      };
    });
    return { services, occurrences };
  }

  /**
   * 수업 히스토리 — 월 기록 + 본인 정산 (덱 §29~31).
   *
   * 정산 규칙은 전부 lib/rules 정본을 소비한다: 인정 = 제출분(D-R7 — 승인 무관),
   * 차감 = 지각뿐(D-R32 — 최초 제출 기준), 원천징수 = 3%·10% 각각 절사(D-15).
   * 가산(N-93 · W11 M2)은 대표의 정리 · 기준 탭 「가산 규칙」 줄을 **시트와 같은 함수**가 더한다 — Kinder 는 표시가 없어 0.
   * 확정된 달은 지급 확정의 근거 줄(payout_line)을 그대로 읽는다(N-36 ①) · 확정 뒤에 쓴 회차는 「확정된 달 — 다음 달 보정」(N-51).
   * 강사 본인의 정산은 시급 비공개(N-94)와 상관없이 늘 본인에게 보인다.
   */
  async history(teacherId: number, month?: string): Promise<TeacherHistoryDto> {
    const today = todayKst();
    const nowMin = nowMinKst();
    const ym = month ?? today.slice(0, 7);

    // 세는 일은 `lib/payout-sheet` 한 곳이다 — 대표의 §57 지급 확정(C94-b)이 같은 함수를 부른다.
    // 여기서 따로 세면 H-82 「미작성분이 포함되면 실패」가 한쪽에서만 지켜진다.
    const sheet = await payoutSheet({ query: (sql, p) => this.q(sql, p) }, teacherId, ym, today, nowMin);
    const { lessons, agg } = sheet;

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

    // 저장된 payout 행이 있으면 그 값이 정본이다 — 화면 계산과 어긋나면 저장값이 이긴다.
    // 「저장돼 있다」와 「확정됐다」는 다른 질문이라 낱말이 아니라 confirmed_by 로 가른다 (N-27).
    const [po] = await this.q(
      `SELECT hours, gross, late_rep_cut, income_tax, local_tax, net, confirmed_by
         FROM payout WHERE staff_id = $1 AND year_month = $2`,
      [teacherId, ym],
    );

    // 확정 · 보정 안내 한 문장 — 서버가 만든다(D-R18 · N-51 「확정된 달 — 다음 달 보정」)
    const confirmedMonth = po ? payoutConfirmed(po.confirmed_by as string | null) : false;
    const noteParts: string[] = [];
    if (confirmedMonth && agg.lateCount > 0) {
      noteParts.push(`이 달은 확정됐습니다 — 확정 뒤에 쓴 리포트 ${agg.lateCount}건은 확정된 달을 바꾸지 않고 다음 달 정산에 보정으로 들어갑니다`);
    }
    if (agg.correctionCount > 0) {
      noteParts.push(`앞선 확정 달의 회차 ${agg.correctionCount}건이 이 달 정산에 보정으로 들어${confirmedMonth ? '갔' : '옵'}니다`);
    }
    const extra = {
      bonus: agg.bonus, correctionCount: agg.correctionCount, lateCount: agg.lateCount,
      note: noteParts.length ? noteParts.join(' · ') : null,
    };
    const breakdown = payoutBreakdown(lessons);
    const breakdownTotal = breakdown.reduce((sum, row) => sum + row.amount, 0);
    const settlementGross = po ? Number(po.gross) : agg.gross;
    const breakdownExtra = {
      breakdown,
      breakdownTotal,
      // 예전 확정 행에 payout_line이 없거나 미확정 저장값이 현재 근거와 다르면 숨기지 않고 차이를 내려준다.
      breakdownUnallocatedAmount: settlementGross - breakdownTotal,
    };
    const settlement = po
      ? {
          yearMonth: ym, confirmed: confirmedMonth, saved: true,
          writtenMinutes: Math.round(Number(po.hours) * 60),
          gross: Number(po.gross), lateCut: Number(po.late_rep_cut),
          incomeTax: Number(po.income_tax), localTax: Number(po.local_tax), net: Number(po.net),
          unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes, unwrittenAmount: agg.unwrittenAmount,
          remainingCount: agg.remainingCount, remainingMinutes: agg.remainingMinutes, remainingAmount: agg.remainingAmount,
          ...extra, ...breakdownExtra,
        }
      : {
          yearMonth: ym, confirmed: false, saved: false,
          writtenMinutes: agg.writtenMinutes + agg.correctionMinutes,
          gross: agg.gross, lateCut: agg.lateCut,
          incomeTax: sheet.incomeTax, localTax: sheet.localTax, net: sheet.net,
          unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes, unwrittenAmount: agg.unwrittenAmount,
          remainingCount: agg.remainingCount, remainingMinutes: agg.remainingMinutes, remainingAmount: agg.remainingAmount,
          ...extra, ...breakdownExtra,
        };

    // 오늘 걸린 가산 규칙 — 대표 정리 · 기준 탭의 칸 그대로(같은 표 · 같은 적용일 셈)
    const rules = await loadBonusRules({ query: (sql, p) => this.q(sql, p) });
    const kindNames = new Map((await this.q(`SELECT key, name FROM kind`)).map((k) => [String(k.key), String(k.name)]));
    const bonusRules = BONUS_D1_DEFAULTS.map((d) => {
      let cur: (typeof rules)[number] | null = null;
      for (const r of rules) {
        if (r.kind === d.kind && r.kindKey === d.kindKey && r.fromDate <= today && (cur === null || r.fromDate > cur.fromDate)) cur = r;
      }
      const applied = d.kind !== 'kinder_hourly' || KINDER_MARKER_EXISTS;
      return {
        label: d.kindKey ? (kindNames.get(d.kindKey) ?? d.kindKey) : BONUS_KIND_LABEL[d.kind],
        hint: BONUS_KIND_HINT[d.kind], amount: cur ? cur.amount : null,
        applied, note: applied ? null : KINDER_NOT_APPLIED,
      };
    });

    return {
      month: ym,
      stats: {
        doneCount: agg.doneCount, doneMinutes: agg.doneMinutes,
        writtenCount: agg.writtenCount, writtenMinutes: agg.writtenMinutes,
        unwrittenCount: agg.unwrittenCount, unwrittenMinutes: agg.unwrittenMinutes,
      },
      wageRate: me?.wage_rate === null || me?.wage_rate === undefined ? null : Number(me.wage_rate),
      wageFrom: (me?.wage_from as string) ?? null,
      // 계약 모양 그대로 옮긴다 — 시트의 안쪽 칸(가산 내역 · 스냅숏 시급)을 그대로 흘리지 않는다
      lessons: lessons.map((l) => ({
        serId: l.serId, onDate: l.onDate, startMin: l.startMin, durMin: l.durMin,
        kindKey: l.kindKey, subKey: l.subKey, mode: l.mode, title: l.title,
        students: l.students, studentCount: l.studentCount, repState: l.repState, canceled: l.canceled,
        submittedAt: l.submittedAt, pay: l.pay, lateCut: l.lateCut, penaltyIfNow: l.penaltyIfNow,
        bonus: l.bonus, settle: l.settle, settleLabel: payoutSettleLabel(l),
        correctionOf: l.correctionOf, paidIn: l.paidIn, frozen: l.frozen,
      })),
      settlement,
      bonusRules,
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
         JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
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
          notes: [],
        };
        byStudent.set(id, s);
      }
      s.weekCount += 1;
      s.lessons.push({
        serId: Number(r.ser_id),
        onDate: String(r.on_date), startMin: Number(r.start_min), durMin: Number(r.dur_min),
        subKey: (r.sub_key as string) ?? null, title: (r.title as string) ?? null,
      });
    }

    const ids = [...byStudent.keys()];
    if (ids.length > 0) {
      const books = await this.q(
        `SELECT i.id AS issue_id, i.student_id, l.code, l.title, l.sub_key, l.level, l.book_level, l.se_te,
                to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
                to_char(i.returned_on,'YYYY-MM-DD') AS returned_on,
                EXISTS (SELECT 1 FROM req q WHERE q.req_type = 'book_change' AND q.state = 'pending'
                           AND q.staff_id = $2 AND (q.payload->>'issueId') = i.id::text) AS change_pending,
                (i.state = 'ok') AS in_use
           FROM issue i JOIN lib l ON l.id = i.lib_id
          WHERE i.student_id = ANY($1)
          ORDER BY (i.returned_on IS NOT NULL), i.issued_on DESC`,
        [ids, teacherId],
      );
      for (const b of books) {
        byStudent.get(Number(b.student_id))?.books.push({
          issueId: Number(b.issue_id), code: String(b.code), title: String(b.title),
          // 레벨은 서가와 같은 낱말 — 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 옛 원문(lib/book 한 함수 · W11 A')
          subKey: (b.sub_key as string) ?? null, level: bookLevelShown(b.book_level as string | null, b.level as string | null),
          seTe: String(b.se_te ?? 'SE'), issuedOn: String(b.issued_on),
          returnedOn: (b.returned_on as string) ?? null,
          // 내가 올린 교재 변경 요청이 이 교재에 열려 있는가 — 단추가 「변경 요청 중」으로 선다 (N-99 · P 영역 두 칸)
          changePending: b.change_pending === true,
          // 「변경 요청」이 눌리는가 — 쓰는 중(ok)이고 열린 요청이 없을 때만. 쓰기(`bookChangePayload`)와 같은 판정이다
          changeRequestable: b.in_use === true && b.change_pending !== true,
        });
      }

      const diags = await this.q(
        `SELECT DISTINCT ON (d.student_id)
                d.student_id, to_char(d.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS on_date,
                d.level_summary, d.strengths, d.weaknesses, d.curriculum, w.name AS by_name
           FROM diag d LEFT JOIN staff w ON w.id = d.created_by
          WHERE d.student_id = ANY($1)
          -- id 로 한 번 더 가른다: created_at 은 기본값이 now() 라 같은 트랜잭션·같은 시각에
          -- 들어온 두 건이 **동점**이 되고, 그때 「최신」이 아무 것이나 된다 (회귀가 잡았다)
          ORDER BY d.student_id, d.created_at DESC, d.id DESC`,
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
            curriculum: (d.curriculum as string) ?? null,
            byName: (d.by_name as string) ?? null,
          };
        }
      }

      /*
       * 인수인계 메모(N-36 ②) — 관리자 · 매니저가 §79 학생 트래킹에서 적은 줄. **이 강사가 이번 주 맡은 학생 것만**이다
       * (위 학생 목록이 `TEACHER_OF` 로 이미 좁혔다). 최근 것부터 스무 줄 — 학부모에게 나가는 글(안내 · 리포트)에는 쓰지 않는다.
       */
      const notes = await this.q(
        `SELECT * FROM (
           SELECT n.id, n.student_id, n.body, w.name AS author_name, ${kstAt('n.created_at')} AS created_at,
                  row_number() OVER (PARTITION BY n.student_id ORDER BY n.created_at DESC, n.id DESC) AS rn
             FROM note n LEFT JOIN staff w ON w.id = n.author_id
            WHERE n.student_id = ANY($1)
         ) x WHERE rn <= 20 ORDER BY student_id, rn`,
        [ids],
      );
      for (const n of notes) {
        byStudent.get(Number(n.student_id))?.notes.push({
          id: Number(n.id), body: String(n.body), authorName: (n.author_name as string) ?? null, createdAt: String(n.created_at),
        });
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
    // N-73 — 지운 줄은 감사 원장에 통째로 남긴다. 읽기 · 판정 · 지우기 · 기록이 한 트랜잭션이다(`audit()` 의 규칙)
    return this.anyRepo.manager.transaction(async (m) => {
      const [row] = (await m.query(
        `SELECT id, staff_id, on_date::text AS on_date, start_min, end_min, reason
           FROM unav WHERE id = $1 AND staff_id = $2 FOR UPDATE`, [id, teacherId],
      )) as Array<{ id: string | number; staff_id: string | number; on_date: string | null; start_min: number; end_min: number; reason: string }>;
      if (!row) throw new NotFoundException('등록을 찾을 수 없습니다');
      const openFromRaw = addDays(todayKst(), UNAV_DEADLINE_DAYS);
      if (!row.on_date || row.on_date < openFromRaw) {
        throw new ConflictException({
          code: 'UNAV_LOCKED',
          message: '마감된 날짜의 등록은 여기서 지울 수 없습니다 — 관리자에게 문의해 주세요',
        });
      }
      await m.query(`DELETE FROM unav WHERE id = $1 AND staff_id = $2`, [id, teacherId]);
      await audit(m, 'unav.delete', {
        actorId: teacherId, entityId: Number(row.id),
        before: {
          staffId: Number(row.staff_id), onDate: row.on_date, startMin: Number(row.start_min),
          endMin: Number(row.end_min), reason: row.reason,
        },
      });
      return { ok: true as const };
    });
  }

  /**
   * 진단 리포트 쓰기 — 강사 원문 슬라이드 20 「04 진단 리포트 · 신규 학생 첫 수업」.
   *
   * **강사만 쓴다.** 원문 슬라이드 47 의 권한 표가 「진단 리포트 작성 — 강사 **가능** ·
   * 나머지 **조회**」라고 적는다. 컨트롤러의 `assertTeacher` 가 역할을 보고, 여기서는
   * **그 학생이 정말 내 학생인지** 다시 본다 — 역할만으로는 남의 학생 진단을 쓸 수 있다.
   *
   * 담당 판정은 새로 만들지 않는다. 수업 안내가 쓰는 `TEACHER_OF` 와 **같은 식**이다 —
   * 회차 담당(`ser_occ.teacher_id`)이 있으면 그것, 없으면 시리즈 담당(`ser.teacher_id`).
   * 두 곳이 따로 판정하면 「안내에는 보이는데 진단은 못 쓰는 학생」이 생긴다.
   *
   * **고치지 않고 쌓는다.** `diag` 에 수정 자리가 없고, 원문도 고치라고 하지 않는다.
   * 진단은 「그때 그 학생이 어땠는가」의 기록이라, 나중에 고치면 그 시점의 판단이 사라진다.
   * 읽기는 늘 최신 한 건이다(`DISTINCT ON`) — 쌓아도 화면은 안 어지럽다.
   */
  async createDiagnostic(teacherId: number, dto: TeacherDiagCreateDto): Promise<TeacherGuideDiagDto> {
    const level = dto.levelSummary.trim();
    if (!level) throw new ConflictException({ code: 'EMPTY_BODY', message: '현재 수준을 적어 주세요' });

    const [mine] = await this.q(
      `SELECT 1 AS ok
         FROM ser_occ o JOIN ser s ON s.id = o.ser_id JOIN ser_stu ss ON ss.ser_id = o.ser_id
        WHERE ss.student_id = $2 AND ${TEACHER_OF} = $1
        LIMIT 1`,
      [teacherId, dto.studentId],
    );
    if (!mine) {
      // 없는 학생과 남의 학생을 같은 말로 돌려보낸다 — 누가 누구 학생인지 흘리지 않는다
      throw new NotFoundException('내 담당 학생이 아닙니다');
    }
    if (dto.serId !== null && dto.serId !== undefined) {
      const [own] = await this.q(
        `SELECT 1 AS ok
           FROM ser_occ o JOIN ser s ON s.id = o.ser_id
          WHERE o.ser_id = $2 AND ${TEACHER_OF} = $1
          LIMIT 1`,
        [teacherId, dto.serId],
      );
      if (!own) throw new NotFoundException('내 수업이 아닙니다');
    }

    const trimmed = (v: string | undefined): string | null => {
      const t = v?.trim();
      return t ? t : null;
    };
    const [row] = await this.q(
      `INSERT INTO diag (student_id, ser_id, level_summary, strengths, weaknesses, curriculum, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING to_char(created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS on_date,
                 level_summary, strengths, weaknesses, curriculum`,
      [
        dto.studentId, dto.serId ?? null, level,
        trimmed(dto.strengths), trimmed(dto.weaknesses), trimmed(dto.curriculum), teacherId,
      ],
    );
    const [me] = await this.q(`SELECT name FROM staff WHERE id = $1`, [teacherId]);
    return {
      onDate: (row.on_date as string) ?? null,
      levelSummary: String(row.level_summary),
      strengths: (row.strengths as string) ?? null,
      weaknesses: (row.weaknesses as string) ?? null,
      curriculum: (row.curriculum as string) ?? null,
      byName: (me?.name as string) ?? null,
    };
  }
}
