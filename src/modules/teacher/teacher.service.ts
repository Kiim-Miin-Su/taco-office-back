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
  ATTENDANCE_CANCEL_REASON_LABEL, REPORT_UNWRITTEN_CANDIDATE_DB,
  effectiveRepStateFromEnded, payoutConfirmed, type AttendanceCancelReason,
} from '../../lib/rules';
import { KST, addDays, isIsoDate, nowMinKst, todayKst } from '../../lib/kst';
import {
  BONUS_D1_DEFAULTS, BONUS_KIND_HINT, BONUS_KIND_LABEL,
  loadBonusRules, payoutBreakdown, payoutSettleLabel, payoutSheet,
} from '../../lib/payout-sheet';
import { drawnDateOf, effectiveModeOf, kstAt, serStuOn, stuPausedOn } from '../../lib/sql';
import { bookAssignmentContextSql } from '../../lib/book-assignment-context';
import { REQ_TYPE_LABEL, labelOf, reqAsked, reqAskedLine } from '../../lib/approval';
import { NOTI_CATEGORY_LABEL, NOTI_WINDOW_DAYS, notiCategory } from '../../lib/noti';
import { wageRateAt } from '../../lib/wage';
import type {
  TeacherDiagCreateDto, TeacherGuideDiagDto, TeacherGuideStudentDto, TeacherGuidesDto,
  TeacherUnavBlockDto, TeacherUnavCreateDto, TeacherUnavDto,
  TeacherHistoryDto, TeacherHomeDto, TeacherLessonDto,
  TeacherLessonHubDto, TeacherLessonHubHistoryItemDto,
  TeacherSuggestionCreateDto, TeacherSuggestionDto, TeacherSuggestionLessonDto, TeacherSuggestionsDto,
  TeacherSettingReqCreateDto, TeacherSettingRequestDto, TeacherSettingsDto,
  TeacherNotiDto, TeacherShellDto,
} from './teacher.dto';
import { SUGGESTION_MONTHLY_LIMIT, UNAV_DEADLINE_DAYS, UNAV_REASON_MIN_LENGTH } from '../../lib/teacher-policy';
import { audit } from '../../lib/audit';
import { bookLevelShown, ISSUE_STATE_LABEL, type IssueState } from '../../lib/book';
import { TeacherLessonMovedException } from './teacher-lesson-moved.error';
import { findTeacherUnavailableLessonConflict, lockTeacherUnavailableWrite } from '../../lib/teacher-unavailable';
import { TeacherUnavailableConflictException } from './teacher-unavailable-conflict.error';
import { chreqAsked } from '../../lib/change-request';

/** created_at(timestamptz) → KST 달력일 — 쿼터·표기 공용 */
const KST_DATE = "(created_at AT TIME ZONE 'Asia/Seoul')::date";
/* 건의 월 한도 · 불가 시간 마감(T07 · 날짜별 10일 전)은 lib/teacher-policy 한 곳 — 강사 정책 띠가 같은 숫자를 읽는다.
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

  /**
   * 강사 홈 — 서버가 teacherId 로 고정한다. 화면은 거르지 않는다 (D-R39).
   *
   * 「오늘」 · 「다가오는 7일」 · 이번 주 수는 **실제 수업일**(`drawnDateOf` · span)로 센다 — 옮긴 회차는 옮긴 날에 선다
   * (MEETING-MOVE). `onDate` 는 키(리포트 화면이 `serId·onDate` 로 연다)라 그대로 실리고, 날짜 표시 · 묶음은 `date` 다.
   */
  async home(teacherId: number): Promise<TeacherHomeDto> {
    const today = todayKst();
    const candidates = [...REPORT_UNWRITTEN_CANDIDATE_DB];
    const DRAWN = drawnDateOf('o');

    const lessons = (await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(${DRAWN},'YYYY-MM-DD') AS date, o.canceled,
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
          AND ${DRAWN} BETWEEN $2::date AND $2::date + 7
        ORDER BY ${DRAWN}, start_min`,
      [teacherId, today],
    )).map((r): TeacherLessonDto => ({
      serId: Number(r.ser_id),
      onDate: String(r.on_date),
      date: String(r.date),
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
              COUNT(*) FILTER (WHERE ${HELD} AND ${DRAWN} = $2::date)::int AS today_lessons,
              COALESCE(SUM(EXTRACT(EPOCH FROM (upper(o.span) - lower(o.span)))/60)
                       FILTER (WHERE ${HELD} AND ${DRAWN} = $2::date), 0)::int AS today_minutes
         FROM ser_occ o
         JOIN ser s      ON s.id = o.ser_id
         LEFT JOIN rep r ON r.ser_id = o.ser_id AND r.on_date = o.on_date
         ${KIND_JOIN}
         ${ATT_JOIN}
        WHERE ${TEACHER_OF} = $1
          AND ${DRAWN} BETWEEN date_trunc('week',$2::date)::date
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
      today: lessons.filter((l) => l.date === today),
      upcoming: lessons.filter((l) => l.date > today),
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
    /** 교재 변경은 학생을 **칸으로** 남긴다(§38 가 req.student_id 를 먼저 읽는다 · 이름 스냅숏은 옛 줄의 대체일 뿐) */
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
      // 시급 · 시간대는 「바라는 것」, 교재 변경은 지금 교재 — 낱말은 lib/approval 한 곳
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
   * 회차별 수업 허브 — 강사 본인의 정확한 `serId + onDate + 실제 date`만 연다.
   *
   * BOC-05D-01 권고안 채택(2026-10-08): 홈·일/주/월 캘린더·리포트에서 같은 회차를
   * 열 수 있도록 서버가 권한과 이동된 실제 날짜를 함께 검증하고, 안내·학생 이력의
   * 구조화 read model을 한 번에 돌려준다. 정책 변경 시 TeacherLessonHub DTO/OpenAPI/generated
   * schema, TeacherSchedule/TeacherLessonHub, BOC-05 scenario·문서·portfolio를 함께 갱신한다.
   */
  async lessonHub(teacherId: number, serId: number, onDate: string, requestedDate: string): Promise<TeacherLessonHubDto> {
    const DRAWN = drawnDateOf('o');
    const [row] = await this.q(
      `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              to_char(${DRAWN},'YYYY-MM-DD') AS date,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span)-lower(o.span)))/60)::int AS dur_min,
              s.kind_key, s.sub_key, ${effectiveModeOf('ex', 's')} AS mode, s.title,
              rm.name AS room_name, rm.branch AS room_branch, z.label AS zacc_label,
              o.canceled, ex.cancel_kind, k.rep AS reportable,
              COALESCE(r.state::text,'none') AS stored_rep_state,
              COALESCE(a.result::text,'completed') AS attendance_result,
              upper(o.span) <= now() AS ended,
              COALESCE(jsonb_agg(jsonb_build_object('id',st.id,'name',st.name) ORDER BY st.name,st.id)
                FILTER (WHERE st.id IS NOT NULL),'[]'::jsonb) AS student_items
         FROM ser_occ o
         JOIN ser s ON s.id=o.ser_id
         LEFT JOIN rep r ON r.ser_id=o.ser_id AND r.on_date=o.on_date
         JOIN kind k ON k.key=COALESCE(r.kind_key,s.kind_key)
         LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
         LEFT JOIN exc ex ON ex.ser_id=o.ser_id AND ex.on_date=o.on_date
         LEFT JOIN room rm ON rm.id=COALESCE(o.room_id,s.room_id)
         LEFT JOIN zacc z ON z.id=o.zacc_id
         LEFT JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ${serStuOn('ss', 'o.on_date')}
           AND NOT ${stuPausedOn('ss.student_id', 'o.on_date')}
           AND NOT EXISTS (
             SELECT 1 FROM exc ex2 JOIN exc_stu_out x ON x.exc_id=ex2.id AND x.student_id=ss.student_id
              WHERE ex2.ser_id=o.ser_id AND ex2.on_date=o.on_date
           )
         LEFT JOIN stu st ON st.id=ss.student_id
        WHERE ${TEACHER_OF}=$1 AND o.ser_id=$2 AND o.on_date=$3::date
        GROUP BY o.ser_id,o.on_date,o.span,s.kind_key,s.sub_key,ex.mode,s.mode,s.title,
                 rm.name,rm.branch,z.label,o.canceled,ex.cancel_kind,k.rep,r.state,a.result`,
      [teacherId, serId, onDate],
    );
    // 존재하지 않는 회차와 다른 강사의 회차는 같은 404 — ID 탐색으로 담당 강사를 추측할 수 없게 한다.
    if (!row) {
      throw new NotFoundException({ code: 'TEACHER_LESSON_NOT_FOUND', message: '담당 수업을 찾을 수 없습니다.' });
    }
    const actualDate = String(row.date);
    if (actualDate !== requestedDate) {
      throw new TeacherLessonMovedException(actualDate);
    }

    const studentItems = (row.student_items as Array<{ id: number | string; name: string }>).map((student) => ({
      id: Number(student.id), name: String(student.name),
    }));
    const studentIds = studentItems.map((student) => student.id);
    const canceled = Boolean(row.canceled) || row.attendance_result === 'canceled';
    const repState = effectiveRepStateFromEnded(
      String(row.stored_rep_state), Boolean(row.reportable) && !canceled, Boolean(row.ended),
    );
    const lesson: TeacherLessonDto = {
      serId: Number(row.ser_id), onDate: String(row.on_date), date: actualDate,
      startMin: Number(row.start_min), durMin: Number(row.dur_min),
      kindKey: String(row.kind_key), subKey: (row.sub_key as string) ?? null,
      mode: row.mode === 'online' ? 'online' : 'offline', title: (row.title as string) ?? null,
      roomName: (row.room_name as string) ?? null, roomBranch: (row.room_branch as string) ?? null,
      zaccLabel: (row.zacc_label as string) ?? null,
      students: studentItems.map((student) => student.name).join(', ') || null,
      canceled: Boolean(row.canceled),
      cancelKindLabel: row.cancel_kind
        ? ATTENDANCE_CANCEL_REASON_LABEL[row.cancel_kind as AttendanceCancelReason] ?? null
        : null,
      repState,
    };

    // 기존 수업 안내 owner를 재사용한다. 취소 회차는 guides가 제외하므로 빈 안내와 명시적 사유가 된다.
    const weeklyGuides = await this.guides(teacherId, actualDate);
    const guideStudents = weeklyGuides.students.filter((student) => studentIds.includes(student.studentId)
      && student.lessons.some((item) => item.serId === serId && item.onDate === onDate));

    const historyRows = studentIds.length === 0 ? [] : await this.q(
      `SELECT o.ser_id,to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              to_char(${DRAWN},'YYYY-MM-DD') AS date,
              (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
              (EXTRACT(EPOCH FROM (upper(o.span)-lower(o.span)))/60)::int AS dur_min,
              s.kind_key,s.sub_key,${effectiveModeOf('ex', 's')} AS mode,s.title,o.canceled,
              k.rep AS reportable,COALESCE(r.state::text,'none') AS stored_rep_state,
              COALESCE(a.result::text,'completed') AS attendance_result,upper(o.span)<=now() AS ended,
              COALESCE(jsonb_agg(jsonb_build_object('id',st.id,'name',st.name) ORDER BY st.name,st.id)
                FILTER (WHERE st.id IS NOT NULL),'[]'::jsonb) AS student_items
         FROM ser_occ o
         JOIN ser s ON s.id=o.ser_id
         LEFT JOIN rep r ON r.ser_id=o.ser_id AND r.on_date=o.on_date
         JOIN kind k ON k.key=COALESCE(r.kind_key,s.kind_key)
         LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
         LEFT JOIN exc ex ON ex.ser_id=o.ser_id AND ex.on_date=o.on_date
         JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ss.student_id=ANY($2::bigint[])
           AND ${serStuOn('ss', 'o.on_date')}
           AND NOT ${stuPausedOn('ss.student_id', 'o.on_date')}
           AND NOT EXISTS (
             SELECT 1 FROM exc ex2 JOIN exc_stu_out x ON x.exc_id=ex2.id AND x.student_id=ss.student_id
              WHERE ex2.ser_id=o.ser_id AND ex2.on_date=o.on_date
           )
         JOIN stu st ON st.id=ss.student_id
        WHERE ${TEACHER_OF}=$1 AND upper(o.span)<=now()
        GROUP BY o.ser_id,o.on_date,o.span,s.kind_key,s.sub_key,ex.mode,s.mode,s.title,
                 o.canceled,k.rep,r.state,a.result
        ORDER BY ${DRAWN} DESC, start_min DESC, o.ser_id DESC
        LIMIT 200`,
      [teacherId, studentIds],
    );
    const history: TeacherLessonHubHistoryItemDto[] = historyRows.map((item) => {
      const itemCanceled = Boolean(item.canceled) || item.attendance_result === 'canceled';
      return {
        serId: Number(item.ser_id), onDate: String(item.on_date), date: String(item.date),
        startMin: Number(item.start_min), durMin: Number(item.dur_min), kindKey: String(item.kind_key),
        subKey: (item.sub_key as string) ?? null, mode: item.mode === 'online' ? 'online' : 'offline',
        title: (item.title as string) ?? null,
        studentItems: (item.student_items as Array<{ id: number | string; name: string }>).map((student) => ({
          id: Number(student.id), name: String(student.name),
        })),
        repState: effectiveRepStateFromEnded(
          String(item.stored_rep_state), Boolean(item.reportable) && !itemCanceled, Boolean(item.ended),
        ),
        canceled: Boolean(item.canceled),
      };
    });

    const capability = (enabled: boolean, reason: string | null) => ({ enabled, reason: enabled ? null : reason });
    const reportEnabled = ['none', 'draft', 'wait', 'ok', 'rej'].includes(repState) && !canceled;
    const [pendingChange] = await this.q(
      `SELECT id, req_type, payload, ${kstAt('created_at')} AS created_at
         FROM chreq
        WHERE ser_id=$1 AND on_date=$2::date AND by_id=$3 AND state='pending'
        ORDER BY created_at DESC,id DESC LIMIT 1`,
      [serId, onDate, teacherId],
    );
    const scheduleChangeRequest = pendingChange ? {
      id: Number(pendingChange.id),
      state: 'pending' as const,
      asked: chreqAsked(String(pendingChange.req_type), pendingChange.payload) ?? '일정 변경',
      createdAt: String(pendingChange.created_at),
    } : null;
    return {
      lesson,
      guideStudents,
      history,
      scheduleChangeRequest,
      capabilities: {
        report: capability(reportEnabled, canceled ? '취소된 수업은 리포트를 열 수 없습니다.'
          : repState === 'plan' ? '수업 종료 후 리포트를 열 수 있습니다.' : '리포트 대상 수업이 아닙니다.'),
        guide: capability(guideStudents.length > 0, canceled
          ? '취소된 수업의 안내는 열 수 없습니다.' : '이 회차에 연결된 학생 안내가 없습니다.'),
        history: capability(history.length > 0, '이 회차 학생의 수업 이력이 없습니다.'),
        scheduleChange: capability(!canceled && scheduleChangeRequest === null,
          canceled ? '취소된 수업은 일정 변경을 요청할 수 없습니다.' : '이 수업의 일정 변경 요청이 관리자 승인 대기 중입니다.'),
      },
    };
  }

  /**
   * 수업 히스토리 — 월 기록 + 본인 정산 (덱 §29~31).
   *
   * 정산 규칙은 전부 lib/rules 정본을 소비한다: 인정 = 제출분(D-R7 — 승인 무관),
   * 차감 = 지각뿐(D-R32 — 최초 제출 기준), 원천징수 = 3%·10% 각각 절사(D-15).
   * 가산(N-93 · BO-09D-02)은 대표의 정리 · 기준 탭 「가산 규칙」 줄을 **시트와 같은 함수**가 더한다.
   * Kinder는 학년·나이가 아닌 명시 표식만 쓰고 일반 class 1명일 때 기본 시급+시간 가산으로 센다.
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
      return {
        label: d.kindKey ? (kindNames.get(d.kindKey) ?? d.kindKey) : BONUS_KIND_LABEL[d.kind],
        hint: BONUS_KIND_HINT[d.kind], amount: cur ? cur.amount : null,
        applied: true, note: null,
      };
    });

    // BOC-09D-03: 특이사항 대상은 표시 이름에서 되짚지 않는다. 지급 시트가 확정한 정확한
    // serId+원래 onDate만 다시 읽고 기간 명단·회차 제외를 적용해 구조화 ID를 붙인다.
    const lessonKeys = [...new Map(lessons.map((lesson) => [
      // jsonb_to_recordset의 SQL 열 이름과 같은 키를 넘긴다. camelCase를 넘기면 두 열이
      // 모두 NULL이 되어 강사 화면에서 특이사항 대상 학생이 사라진다(BO-09E-02).
      `${lesson.serId}:${lesson.onDate}`, { ser_id: lesson.serId, on_date: lesson.onDate },
    ])).values()];
    const studentRows = lessonKeys.length ? await this.q(`WITH keys AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(ser_id bigint,on_date date)
      ) SELECT k.ser_id,k.on_date::text,
        COALESCE(jsonb_agg(jsonb_build_object('id',st.id,'name',st.name) ORDER BY st.name,st.id)
          FILTER (WHERE st.id IS NOT NULL),'[]'::jsonb) AS students
      FROM keys k
      LEFT JOIN ser_stu ss ON ss.ser_id=k.ser_id
        AND (ss.from_date IS NULL OR ss.from_date <= k.on_date)
        AND (ss.to_date IS NULL OR ss.to_date >= k.on_date)
        AND NOT EXISTS (SELECT 1 FROM exc e JOIN exc_stu_out x ON x.exc_id=e.id AND x.student_id=ss.student_id
          WHERE e.ser_id=k.ser_id AND e.on_date=k.on_date)
      LEFT JOIN stu st ON st.id=ss.student_id GROUP BY k.ser_id,k.on_date`, [JSON.stringify(lessonKeys)]) : [];
    const studentsByLesson = new Map(studentRows.map((row) => [
      `${Number(row.ser_id)}:${String(row.on_date)}`,
      (row.students as Array<{ id: number | string; name: string }>).map((student) => ({ id: Number(student.id), name: student.name })),
    ]));

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
        serId: l.serId, onDate: l.onDate, date: l.date, startMin: l.startMin, durMin: l.durMin,
        kindKey: l.kindKey, subKey: l.subKey, mode: l.mode, title: l.title,
        students: l.students, studentItems: studentsByLesson.get(`${l.serId}:${l.onDate}`) ?? [],
        studentCount: l.studentCount, repState: l.repState, canceled: l.canceled,
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
              o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(${drawnDateOf('o')},'YYYY-MM-DD') AS date,
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
          -- 이번 주에 **실제로 하는** 회차 — 옮긴 회차는 옮긴 주에 든다 (MEETING-MOVE · drawnDateOf)
          AND ${drawnDateOf('o')} BETWEEN wk.f AND wk.t
        ORDER BY ${drawnDateOf('o')}, start_min, st.name`,
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
        onDate: String(r.on_date), date: String(r.date), startMin: Number(r.start_min), durMin: Number(r.dur_min),
        subKey: (r.sub_key as string) ?? null, title: (r.title as string) ?? null,
      });
    }

    const ids = [...byStudent.keys()];
    if (ids.length > 0) {
      /*
       * 학생 교재 — 배부 원장(ISSUE)의 **배부됐거나 배부 예정인** 줄만(취소·반려는 학생 손에 간 적이 없다).
       * 상태는 원장 낱말 그대로 싣고 화면이 「사용 중 · 교재 완료 · 배부 대기」를 그 값으로 가른다 — 전에는 회수일 유무로만 갈라
       * 승인 대기(wait) · 전달 대기(auto)가 「사용 중」으로 서고 배부일이 "null" 로 찍혔다(TEACHER-LINEAGE 2026-09-29).
       * 재배부 계보(`issue.reissued_from` · 1:1)는 양쪽 id 로 싣는다 — 옛 배부 줄은 「→ 재배부」, 새 줄은 「이전 배부에서 재배부」.
       */
      const books = await this.q(
        `SELECT i.id AS issue_id, i.student_id, i.state, l.code, l.title, l.sub_key, l.level, l.book_level, l.se_te,
                CASE WHEN book_access.can_download THEN v.se_file_id END AS se_file_id,
                CASE WHEN book_access.can_download THEN v.te_file_id END AS te_file_id,
                to_char(i.issued_on,'YYYY-MM-DD') AS issued_on,
                to_char(i.returned_on,'YYYY-MM-DD') AS returned_on,
                i.reissued_from,
                (SELECT c.id FROM issue c WHERE c.reissued_from = i.id) AS reissued_to,
                EXISTS (SELECT 1 FROM req q WHERE q.req_type = 'book_change' AND q.state = 'pending'
                           AND q.staff_id = $2 AND (q.payload->>'issueId') = i.id::text) AS change_pending,
                (i.state = 'ok') AS in_use
           FROM issue i JOIN lib l ON l.id = i.lib_id
           LEFT JOIN vers v ON v.id=i.vers_id AND v.lib_id=i.lib_id
           -- 선택한 과거 주의 학생 정보는 유지하되 파일 권한은 다운로드 경로와 같이 오늘 기준으로 다시 판정한다.
           LEFT JOIN LATERAL (
             SELECT i.teacher_id=$2 AND i.state='ok' AND EXISTS (${bookAssignmentContextSql({
               teacherId: 'i.teacher_id', subKey: 'i.sub_key', studentId: 'i.student_id', today: '$3',
             })}) AS can_download
           ) book_access ON true
          WHERE i.student_id = ANY($1) AND i.state IN ('wait','auto','ok','returned')
          ORDER BY (i.returned_on IS NOT NULL), i.issued_on DESC NULLS FIRST, i.id DESC`,
        [ids, teacherId, todayKst()],
      );
      for (const b of books) {
        const state = String(b.state) as IssueState;
        byStudent.get(Number(b.student_id))?.books.push({
          issueId: Number(b.issue_id), code: String(b.code), title: String(b.title),
          seFileId: b.se_file_id == null ? null : Number(b.se_file_id),
          teFileId: b.te_file_id == null ? null : Number(b.te_file_id),
          // 레벨은 서가와 같은 낱말 — 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 옛 원문(lib/book 한 함수 · W11 A')
          subKey: (b.sub_key as string) ?? null, level: bookLevelShown(b.book_level as string | null, b.level as string | null),
          seTe: String(b.se_te ?? 'SE'),
          state, stateLabel: ISSUE_STATE_LABEL[state],
          issuedOn: (b.issued_on as string) ?? null,
          returnedOn: (b.returned_on as string) ?? null,
          reissuedFrom: b.reissued_from == null ? null : Number(b.reissued_from),
          reissuedTo: b.reissued_to == null ? null : Number(b.reissued_to),
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
    const lesson = r.lesson_snapshot as TeacherSuggestionLessonDto | null | undefined;
    return {
      id: Number(r.id),
      category: String(r.category),
      body: String(r.body),
      state: String(r.state),
      createdOn: String(r.created_on),
      reply: (r.reply as string) ?? null,
      replyBy: (r.reply_by_name as string) ?? null,
      replyOn: (r.reply_on as string) ?? null,
      lesson: lesson ?? null,
    };
  }

  /** 건의 사항 — 내가 보낸 것 + 이달 쿼터 (덱 §33~34 · 월 3회는 서버가 센다). */
  async suggestions(teacherId: number): Promise<TeacherSuggestionsDto> {
    const today = todayKst();
    const used = await this.suggestionUsed(teacherId, today);
    const items = await this.q(
      `SELECT g.id, g.category::text AS category, g.body, g.state::text AS state, g.lesson_snapshot,
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
   *
   * BO-06D-03 권고안: 10일 미만·지난 수업의 팝업 건의는 일반 건의 원장을 재사용하되,
   * client 표시 문자열을 믿지 않고 서버가 exact 회차를 다시 읽어 제출 당시 수업 스냅숏을 만든다.
   * requestKey 재시도·sourceDate/readVersion stale 판정·SER 공유 잠금은 한 transaction이다.
   * 이 계약을 바꾸면 DTO/Swagger→OpenAPI/generated Front, migration/DBML, 두 수정사항 대조표,
   * 시나리오와 portfolio를 같은 청크에서 갱신한다.
   */
  async createSuggestion(teacherId: number, dto: TeacherSuggestionCreateDto): Promise<TeacherSuggestionDto> {
    const today = todayKst();
    const body = dto.body.trim();
    if (!body) throw new ConflictException({ code: 'EMPTY_BODY', message: '내용을 적어 주세요' });
    if (dto.lesson && !dto.requestKey) {
      throw new BadRequestException({
        code: 'SUGGESTION_REQUEST_KEY_REQUIRED',
        message: '수업에 연결한 건의는 요청 키가 필요합니다',
      });
    }

    // 멱등 키 → SER → 월 쿼터 순서로 잠근다. 같은 키 재전송은 쿼터를 다시 쓰지 않고 기존 receipt로 수렴한다.
    const inserted = await this.anyRepo.manager.transaction(async (em) => {
      if (dto.requestKey) {
        await em.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`suggestion:${teacherId}:${dto.requestKey}`]);
        const [prior] = (await em.query(
          `SELECT g.id, g.category::text AS category, g.body, g.state::text AS state, g.lesson_snapshot,
                  g.ser_id, to_char(g.on_date,'YYYY-MM-DD') AS on_date,
                  to_char(g.source_date,'YYYY-MM-DD') AS source_date, g.read_version,
                  to_char((g.created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS created_on,
                  g.reply, st.name AS reply_by_name,
                  to_char((g.reply_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS reply_on
             FROM suggestion g LEFT JOIN staff st ON st.id=g.reply_by
            WHERE g.staff_id=$1 AND g.request_key=$2::uuid`,
          [teacherId, dto.requestKey],
        )) as R[];
        if (prior) {
          const sameLesson = dto.lesson
            ? Number(prior.ser_id) === dto.lesson.serId
              && prior.on_date === dto.lesson.onDate
              && prior.source_date === dto.lesson.sourceDate
              && Number(prior.read_version) === dto.lesson.readVersion
            : prior.ser_id == null && prior.on_date == null && prior.source_date == null && prior.read_version == null;
          if (prior.category !== dto.category || prior.body !== body || !sameLesson) {
            throw new ConflictException({
              code: 'SUGGESTION_REQUEST_KEY_REUSED',
              message: '같은 요청 키로 다른 건의가 이미 접수되었습니다',
            });
          }
          return [prior];
        }
      }

      let lessonSnapshot: TeacherSuggestionLessonDto | null = null;
      if (dto.lesson) {
        await em.query(`SELECT id FROM ser WHERE id=$1 FOR SHARE`, [dto.lesson.serId]);
        const [lesson] = (await em.query(
          `SELECT o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date,
                  to_char(${drawnDateOf('o')},'YYYY-MM-DD') AS date,
                  (EXTRACT(EPOCH FROM (lower(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS start_min,
                  (EXTRACT(EPOCH FROM (upper(o.span) AT TIME ZONE 'Asia/Seoul')::time)/60)::int AS end_min,
                  COALESCE(sb.name,k.name) AS subject, s.title, o.canceled,
                  COALESCE(a.result::text,'completed') AS attendance_result,
                  COALESCE(jsonb_agg(st.name ORDER BY st.name,st.id)
                    FILTER (WHERE st.id IS NOT NULL),'[]'::jsonb) AS students
             FROM ser_occ o
             JOIN ser s ON s.id=o.ser_id
             JOIN kind k ON k.key=s.kind_key
             LEFT JOIN sub sb ON sb.key=s.sub_key
             LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
             LEFT JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ${serStuOn('ss', 'o.on_date')}
               AND NOT ${stuPausedOn('ss.student_id', 'o.on_date')}
               AND NOT EXISTS (
                 SELECT 1 FROM exc ex2 JOIN exc_stu_out x ON x.exc_id=ex2.id AND x.student_id=ss.student_id
                  WHERE ex2.ser_id=o.ser_id AND ex2.on_date=o.on_date
               )
             LEFT JOIN stu st ON st.id=ss.student_id
            WHERE ${TEACHER_OF}=$1 AND o.ser_id=$2 AND o.on_date=$3::date
            GROUP BY o.ser_id,o.on_date,o.span,s.title,sb.name,k.name,o.canceled,a.result`,
          [teacherId, dto.lesson.serId, dto.lesson.onDate],
        )) as R[];
        if (!lesson) {
          throw new NotFoundException({ code: 'SUGGESTION_LESSON_NOT_FOUND', message: '건의를 보낼 담당 수업을 찾을 수 없습니다' });
        }
        if (lesson.canceled === true || lesson.attendance_result === 'canceled') {
          throw new ConflictException({ code: 'SUGGESTION_LESSON_CHANGED', message: '취소된 수업에는 일정 건의를 보낼 수 없습니다' });
        }
        const actualDate = String(lesson.date);
        if (actualDate !== dto.lesson.sourceDate) {
          throw new ConflictException({
            code: 'SUGGESTION_LESSON_STALE',
            message: '읽은 뒤 수업 날짜가 변경되었습니다. 현재 일정에서 다시 요청해 주세요',
            sourceDate: dto.lesson.sourceDate,
            currentDate: actualDate,
          });
        }
        const remainingDays = diffDays(today, actualDate);
        if (remainingDays >= 10) {
          throw new ConflictException({
            code: 'SUGGESTION_CHANGE_REQUEST_REQUIRED',
            message: '수업일까지 정확히 10일 이상이면 일정 변경 요청을 사용해 주세요',
            today, lessonDate: actualDate, remainingDays, minimumDays: 10,
          });
        }
        const [changed] = (await em.query(
          `SELECT id FROM log WHERE id>$1 AND entity='SER' AND entity_id=$2 ORDER BY id LIMIT 1`,
          [dto.lesson.readVersion, dto.lesson.serId],
        )) as Array<{ id: string }>;
        if (changed) {
          throw new ConflictException({
            code: 'SUGGESTION_LESSON_STALE',
            message: '읽은 뒤 수업 일정이 변경되었습니다. 현재 일정에서 다시 요청해 주세요',
            readVersion: dto.lesson.readVersion,
            currentVersion: Number(changed.id),
          });
        }
        lessonSnapshot = {
          serId: Number(lesson.ser_id), onDate: String(lesson.on_date), date: actualDate,
          startMin: Number(lesson.start_min), endMin: Number(lesson.end_min),
          subject: String(lesson.subject), title: (lesson.title as string) ?? null,
          students: (lesson.students as string[]).map(String),
        };
      }

      // 잠금 + 판정 + 삽입을 한 트랜잭션으로 — 동시 요청 두 개가 같은 「2/3」을 보고 둘 다 들어가는 창을 닫는다
      await em.query(`SELECT pg_advisory_xact_lock(hashtext('suggestion-quota'), $1::int)`, [teacherId]);
      return em.query(
        `INSERT INTO suggestion
           (staff_id, category, body, ser_id, on_date, source_date, read_version, lesson_snapshot, request_key)
         SELECT $1, $2::sug_cat_t, $3, $5, $6::date, $7::date, $8, $9::jsonb, $10::uuid
          WHERE (SELECT COUNT(*) FROM suggestion
                  WHERE staff_id = $1
                    AND ${KST_DATE} >= date_trunc('month', $4::date)::date
                    AND ${KST_DATE} <  (date_trunc('month', $4::date) + interval '1 month')::date)
                < ${SUGGESTION_MONTHLY_LIMIT}
         RETURNING id, category::text AS category, body, state::text AS state,
                   to_char((created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS created_on,
                   lesson_snapshot, reply, NULL AS reply_by_name, NULL AS reply_on`,
        [
          teacherId, dto.category, body, today,
          dto.lesson?.serId ?? null, dto.lesson?.onDate ?? null, dto.lesson?.sourceDate ?? null,
          dto.lesson?.readVersion ?? null, lessonSnapshot ? JSON.stringify(lessonSnapshot) : null,
          dto.requestKey ?? null,
        ],
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
   * openFrom = max(회차 시작, 오늘+10) — 최신 강사 수정사항의 10일 포함 기준을 서버 한 곳에서 계산한다.
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
   * 등록 — 마감(날짜별 10일 전), trim 사유 15자, 본인 UNAV 및 실제 배정 수업 겹침을 서버가 판정한다.
   * 시간표 projection과 같은 강사 advisory lock을 잡아 동시 편성↔등록 결과도 직렬화한다.
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
        message: '등록은 대상 날짜 10일 전까지만 가능합니다. 10일 안의 사정은 강사 단톡방에 올려 주세요 — 관리자가 확인하고 직접 조정합니다',
      });
    }
    const reason = dto.reason.trim();
    if (reason.length < UNAV_REASON_MIN_LENGTH) {
      throw new ConflictException({ code: 'UNAV_REASON_TOO_SHORT', message: `사유는 앞뒤 공백을 제외하고 ${UNAV_REASON_MIN_LENGTH}자 이상 적어 주세요` });
    }

    const inserted = await this.anyRepo.manager.transaction(async (em) => {
      await lockTeacherUnavailableWrite(em, [teacherId]);
      const lesson = await findTeacherUnavailableLessonConflict(
        em, teacherId, dto.onDate, dto.startMin, dto.endMin,
      );
      if (lesson) throw new TeacherUnavailableConflictException(lesson);
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

  /** 삭제 — 본인 행이면서 아직 열린 날짜(오늘+10 이후)만. 마감분·legacy(날짜 미상)는 관리자 조정 대상. */
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
