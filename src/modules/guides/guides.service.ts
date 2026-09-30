/** @file-guide
 * 목적: guides.service.ts — GuidesService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { canAdminPage, hasPerm, isRole, type RequestUser } from '../../common/perm';
import { histLabel, histSql } from '../../lib/history';
import { NOTI_TITLE } from '../../lib/noti';
import { audit } from '../../lib/audit';
import { bookLevelShown, issueActiveSql } from '../../lib/book';
import { SENDER, type Sender } from '../notify/sender';
import { GUIDE_DONE_DB, GUIDE_PENDING_DB } from '../../lib/rules';
import type {
  GuideBodyDto, GuideClassDiagListDto, GuideClassDiagWriteDto, GuideCopyResultDto, GuideDraftCreateDto, GuideDto, GuideHistoryDayDto, GuideHistoryDto,
  GuideHistoryEventDto, GuideHistoryQueryDto,
  GuideHistorySpan, GuideMissingDto, GuideStudentsDto, GuideTemplateDto, GuideTemplateWriteDto, GuidesDto,
  PerLessonNoticeDto, ReceivedGuidesDto, ZoomNoticeBatchInfoDto, ZoomNoticeBatchResultDto, ZoomNoticeBatchRowDto,
  ZoomNoticeResultDto, ZoomNoticeWriteDto,
} from './guides.dto';
import { guideAutoFill, guideAutoFills, PREVIOUS_TEACHER_SQL } from '../../lib/guide-body';
import {
  GUIDE_EVENT_CTE, GUIDE_HISTORY_EVENTS, GUIDE_LESSON_JOINS, guideCoversEvent, guideKindLabel,
} from './guide-events';
import { guideDeadline } from './guide-deadline';
import { latestLeadDiagForStudent } from '../ops/lead-diag.service';

/**
 * §43 할 일에 세우는 「안내 없음」의 창 — 수업 날 기준 **최근 30일 ~ 앞으로 7일**.
 * 판정(누가 필요한가)은 §45 와 같은 함수이고, 이 창은 할 일 목록이 몇 해 전 사건까지 끌고 오지 않게 하는 보기 범위다.
 * 창 밖의 지난 누락은 §45 이력(기간 이동)에서 여전히 보인다.
 */
const TODO_MISSING_BACK_DAYS = 30;
const TODO_MISSING_AHEAD_DAYS = 7;
import { END_MIN, effectiveModeOf, hhmmOf, kstAt, kstDateOf, START_MIN, serStuOn, writtenRows } from '../../lib/sql';
import { addDays, isIsoDate, overdueDays as overdue, todayKst } from '../../lib/kst';

type R = Record<string, unknown>;
type GuideActionSource = {
  state: string; teacherId: number | null; body: string | null;
  recipientActive: boolean; recipientRole: string | null;
};

/**
 * 학부모 외부 발송이 **지금 되는가** — 판정은 발송 경계(`Sender.ready`) 한 곳이다 (DQ3 · 2026-09-25).
 * 보호자(수신처)는 이제 있다(`guardian`). 남은 조건은 채널 설정뿐이라, 이메일·문자 둘 다 설정이 없을 때만 막힌 이유를 준다.
 * 강사 안내는 앱 안 알림(NOTI)이 전달이다 — 강사 쪽 외부 채널은 만들지 않으므로 teacherExternal 은 늘 false 이고 이유 문장에 섞지 않는다.
 */
const PARENT_CHANNELS_OFF = '이메일·문자 발송 설정이 없어 학부모 안내를 실제로 보내지 못합니다 — 보내면 「설정 없음」으로 기록됩니다';

/* 수업 이름표(GUIDE_LESSON_JOINS)와 안내가 필요한 사건(GUIDE_EVENT_CTE)은 guide-events.ts 한 벌이다 —
   현황판 §34 안내 마크도 같은 식을 쓴다. */

/**
 * 「회차마다 나가는 안내」를 **무엇으로 찾는가** (S5).
 *
 * 사람이 보는 목록은 **그날 그려지는 것**을 모으고(`drawnOn`), 쓰기의 되읽기는 방금 쓴
 * **그 회차**를 키로 집는다. 옮긴 회차에서 이 둘은 다른 날짜다.
 */
type PerLessonScope =
  | { drawnOn: string; teacherId: number | null }
  | { serId: number; onDate: string };

/**
 * 강사 교체 초안이 물려받는 **지도 방향** — 그 학생의 가장 최근 안내(§44 「가장 최근 안내가 현재 유효한 것」)의 `direction`.
 * 규칙을 가리지 않는다(「이 날부터」는 규칙을 가르므로 새 규칙에는 이전 안내가 없다). 없으면 NULL — 지어내지 않는다.
 * `studentParam` 은 학생 id 자리 표시자(`$2` 등)다.
 */
const INHERITED_DIRECTION_SQL = (studentParam: string): string =>
  `(SELECT pg.direction FROM guide pg WHERE pg.student_id=${studentParam} ORDER BY pg.created_at DESC,pg.id DESC LIMIT 1)`;


/**
 * 같은 반 학생(형제 안내) — 같은 규칙·같은 날·같은 사유의 다른 학생 안내를 이름 차례로 (F-60 · F-61 · all160 2026-09-30).
 * 수(`siblingCount`)도 이 목록의 길이로 낸다 — 수와 목록을 따로 세면 둘이 갈린다 (D-R22).
 * 복사(`copyBody`)의 형제 판정과 같은 조건 · 같은 차례다.
 */
const SIBLINGS_SQL = `(SELECT COALESCE(json_agg(json_build_object('id', sg.id, 'studentName', ss.name, 'state', sg.state) ORDER BY ss.name, sg.id), '[]'::json)
                 FROM guide sg LEFT JOIN stu ss ON ss.id=sg.student_id
                WHERE sg.ser_id=g.ser_id AND sg.event_on=g.event_on AND sg.reason=g.reason AND sg.id<>g.id)`;

@Injectable()
export class GuidesService {
  constructor(
    @InjectRepository(Lead) private readonly anyRepo: Repository<Lead>,
    @Inject(SENDER) private readonly sender: Sender,
  ) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  private async guideRows(where = '', params: unknown[] = [], manager?: EntityManager, viewer?: RequestUser): Promise<GuideDto[]> {
    const run = manager
      ? (sql: string, p: unknown[]) => manager.query(sql, p) as Promise<R[]>
      : (sql: string, p: unknown[]) => this.q(sql, p);
    const rows = await run(
      `SELECT g.id,g.ser_id,g.student_id,g.teacher_id,g.reason,g.state,g.body,g.direction,g.admin_note,g.created_by,
              ${SIBLINGS_SQL} AS siblings,
              to_char(g.due_on,'YYYY-MM-DD') AS due_on,
              COALESCE(to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD'),to_char(g.event_on,'YYYY-MM-DD')) AS event_on,
              o.id AS source_occurrence_id,
              ${kstAt('lower(o.span)')} AS start_at,
              ${kstAt('g.created_at')} AS created_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by,
              (SELECT st.name FROM hist h LEFT JOIN staff st ON st.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send') AS sent_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by,
              (SELECT st.name FROM hist h LEFT JOIN staff st ON st.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack') AS acknowledged_at,
              s.name AS student_name,t.name AS teacher_name,r.title AS ser_title,cb.name AS created_by_name,
              sb.name AS sub_name,k.name AS kind_name,COALESCE(${START_MIN},r.start_min) AS start_min,rm.name AS room_name,
              t.active AS recipient_active,t.role AS recipient_role,
              pt.id AS previous_teacher_id,pt.name AS previous_teacher_name
         FROM guide g
         LEFT JOIN stu s ON s.id=g.student_id
         LEFT JOIN staff t ON t.id=g.teacher_id
         LEFT JOIN ser r ON r.id=g.ser_id
         LEFT JOIN staff cb ON cb.id=g.created_by
         LEFT JOIN ser_occ o ON o.ser_id=g.ser_id AND o.on_date=g.event_on
         ${GUIDE_LESSON_JOINS('r')}
         -- 이전 강사(간이 안내만 · 장부에서 되짚는다 · TEACHER-LINEAGE) — 첫 수업 안내는 NULL
         LEFT JOIN staff pt ON pt.id=${PREVIOUS_TEACHER_SQL('g', 'o')}
         ${where}
         ORDER BY g.created_at DESC,g.id DESC`,
      params,
    );
    const mapped = rows.map((row) => this.mapGuide(row, viewer));
    await this.attachAutoFill(mapped, manager);
    return mapped;
  }


  /**
   * §43 「회차마다 나가는 안내」 (F-63).
   *
   * **정본은 온라인 SER_OCC** 이고 PNOTI 는 발송 기록이다. 목록과 줌 안내 쓰기 응답이
   * 같은 함수를 쓴다 — 두 곳이 따로 만들면 보낸 직후의 줄이 목록과 다른 모양으로 보인다.
   *
   * **거르는 날과 돌려주는 날이 다르다** — 거르는 것은 「그려지는 날」(`lower(o.span)` 의 KST 날짜)이고
   * 돌려주는 `onDate` 는 **회차 키**(`o.on_date`)다. 사람은 달력 날짜로 고르고 쓰기는 회차 키로 찾기
   * 때문이다(C82-b — `ser_occ.id` 는 재투영 때 바뀌므로 키가 될 수 없다). 옮긴 회차에서 이 둘이
   * 갈리는데, 전에는 둘 다 「그려지는 날」로 내려보내 **쓰기가 그 회차를 못 찾았다**(S5).
   *
   * 그래서 **찾는 방법도 둘**이다 — 목록은 그날 그려지는 것을 모으고(`drawnOn`), 쓰기의 되읽기는
   * 방금 쓴 그 회차를 **키로** 집는다(`serId`+`onDate`). 되읽기까지 「그려지는 날」로 찾으면
   * 옮긴 회차에서는 **쓰기가 끝난 뒤에 404** 가 났다 — 알림은 갔는데 화면은 실패로 읽는다.
   */
  private async perLessonRows(scope: PerLessonScope): Promise<PerLessonNoticeDto[]> {
    const byKey = 'serId' in scope;
    const where = byKey
      ? `o.ser_id=$1 AND o.on_date=$2::date`
      : `${kstDateOf('lower(o.span)')}=$1::date AND ($2::bigint IS NULL OR o.teacher_id=$2)`;
    const params: unknown[] = byKey ? [scope.serId, scope.onDate] : [scope.drawnOn, scope.teacherId];
    const perRows = await this.q(
      `SELECT o.id AS source_occurrence_id,o.ser_id,
              -- 회차 키를 준다 (S5). 전에는 「그려지는 날」을 on_date 라 불러 내려보냈는데,
              -- 같은 질의의 PNOTI 조인과 쓰기(sendZoomNotice)는 o.on_date 를 쓴다 — 옮긴 회차에서
              -- 화면이 되돌려 보낸 날짜로는 회차를 못 찾아 404 가 나거나, 그 날짜의 다른 회차에 붙었다.
              to_char(o.on_date,'YYYY-MM-DD') AS on_date,
              ${START_MIN} AS start_min,${END_MIN} AS end_min,
              o.teacher_id,t.name AS teacher_name,r.title AS ser_title,k.name AS kind_name,
              sb.name AS sub_name,rm.name AS room_name,
              o.zacc_id,z.label AS zacc_label,ss.student_id,st.name AS student_name,
              p.id AS notice_id,p.channel,p.body,${kstAt('p.sent_at')} AS sent_at,
              (SELECT ${kstAt('pt.sent_at')} FROM pnoti pt
                WHERE pt.ser_id=o.ser_id AND pt.on_date=o.on_date AND pt.audience='teacher'
                ORDER BY pt.id DESC LIMIT 1) AS teacher_sent_at
         FROM ser_occ o
         JOIN ser r ON r.id=o.ser_id
         JOIN kind k ON k.key=r.kind_key
         LEFT JOIN sub sb ON sb.key=r.sub_key
         -- 회차의 강의실 — 투영(o.room_id)이 이미 예외를 반영한다. 규칙의 강의실로 떨어지면
         -- 그 회차만 온라인으로 바꾼 수업(강의실 NULL)에 규칙의 강의실 이름이 붙는다 (A′2 · 현황판과 같은 조인)
         LEFT JOIN room rm ON rm.id=o.room_id
         JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ${serStuOn('ss', 'o.on_date')}
         JOIN stu st ON st.id=ss.student_id
         LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
         LEFT JOIN staff t ON t.id=o.teacher_id
         LEFT JOIN zacc z ON z.id=o.zacc_id
         LEFT JOIN LATERAL (
           SELECT pn.id,pn.channel,pn.body,pn.sent_at
             FROM pnoti pn
            WHERE pn.ser_id=o.ser_id AND pn.on_date=o.on_date AND pn.student_id=ss.student_id
              AND pn.audience='parent'
            ORDER BY pn.id DESC
            LIMIT 1
         ) p ON true
        WHERE NOT o.canceled
          -- 회차의 실제 방식 — 그 회차만 온라인/현장으로 바꾼 예외(exc.mode)가 이긴다 (N-56 · lib/sql 한 조각)
          AND ${effectiveModeOf('x', 'r')} = 'online'
          AND ${where}
          AND NOT EXISTS (
            SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id
          )
        ORDER BY lower(o.span),o.id,st.name,st.id,p.id DESC`,
      params,
    );
    const byOccurrence = new Map<number, R[]>();
    for (const row of perRows) {
      const id = Number(row.source_occurrence_id);
      byOccurrence.set(id, [...(byOccurrence.get(id) ?? []), row]);
    }
    return [...byOccurrence.values()].map((rows) => {
      const first = rows[0];
      const notices = rows.map((row) => ({
        id: row.notice_id == null ? null : Number(row.notice_id),
        studentId: Number(row.student_id), studentName: String(row.student_name),
        channel: (row.channel as string) ?? null, body: (row.body as string) ?? null,
        sentAt: (row.sent_at as string) ?? null,
      }));
      const recorded = notices.length > 0 && notices.every((notice) => notice.sentAt !== null);
      const firstNotice = notices.find((notice) => notice.id !== null);
      const gate = GuidesService.sendGate({
        alreadySent: first.teacher_sent_at != null,
        zaccId: first.zacc_id == null ? null : Number(first.zacc_id),
        teacherId: first.teacher_id == null ? null : Number(first.teacher_id),
      });
      return {
        id: Number(first.source_occurrence_id), sourceOccurrenceId: Number(first.source_occurrence_id),
        serId: Number(first.ser_id), onDate: String(first.on_date),
        startMin: Number(first.start_min), endMin: Number(first.end_min),
        teacherId: first.teacher_id == null ? null : Number(first.teacher_id),
        teacherName: (first.teacher_name as string) ?? null,
        kindName: (first.kind_name as string) ?? null,
        subName: (first.sub_name as string) ?? null,
        roomName: (first.room_name as string) ?? null,
        zaccId: first.zacc_id == null ? null : Number(first.zacc_id),
        zaccLabel: (first.zacc_label as string) ?? null,
        zoomAssigned: first.zacc_id != null,
        notices,
        parentDeliveryRecorded: recorded,
        // 강사 줄이 실제로 생기고 sent_at 이 찍혔을 때만 참이다 (F-63 — 그 전에는 쓰는 길이 0이었다)
        teacherDeliveryRecorded: first.teacher_sent_at != null,
        canSendTeacher: gate.canSendTeacher,
        sendBlockedReason: gate.sendBlockedReason,
        channel: firstNotice?.channel ?? 'app',
        studentName: notices.map((notice) => notice.studentName).join(', '),
        serTitle: (first.ser_title as string) ?? null,
        body: firstNotice?.body ?? '',
        sentAt: recorded ? notices.map((notice) => notice.sentAt).sort().at(-1) ?? null : null,
      };
    });
  }

  /**
   * 아직 안 쓴 초안에만 자동 채움을 얹는다 (F-60).
   *
   * **저장하지 않는다** — 읽을 때마다 지금 사실로 만든다. 굳혀 두면 교재가 나중에 배정될 때
   * 낡은 말이 남는다. 이미 쓴 안내(`ready` 이상)는 사람이 쓴 말이 정본이라 건드리지 않는다.
   * 질의는 **한 번**이다 — 안내마다 물으면 목록 하나에 왕복이 안내 수만큼 는다.
   */
  private async attachAutoFill(guides: GuideDto[], manager?: EntityManager): Promise<void> {
    const drafts = guides.filter((g) => g.state === 'draft');
    if (drafts.length === 0) return;
    const runner = manager ?? this.anyRepo.manager;
    const fills = await guideAutoFills(runner, drafts.map((g) => g.id));
    for (const guide of drafts) guide.autoFill = fills.get(guide.id) ?? null;
  }

  /** 버튼과 직접 전이의 동일 판정. guide 생략은 조회 전 actor 권한 검사에만 사용한다. */
  private static guideCapabilities(viewer?: RequestUser, guide?: GuideActionSource) {
    const role = viewer?.role;
    const canManage = isRole(role) && hasPerm(role, 'canAdminPage', viewer?.perms) && hasPerm(role, 'canCrudAll', viewer?.perms);
    const actualTeacher = isRole(role) && !canAdminPage(role);
    const isRecipient = actualTeacher && guide?.teacherId === viewer?.id;
    const recipientEligible = Boolean(guide?.teacherId && guide.recipientActive
      && isRole(guide.recipientRole) && !canAdminPage(guide.recipientRole));
    let sendBlockedReason: string | null = null;
    let sendBlockedCode: string | null = null;
    if (!canManage) sendBlockedReason = '안내를 발송할 권한이 없습니다';
    else if (guide?.state !== 'ready') {
      sendBlockedCode = 'GUIDE_NOT_READY';
      sendBlockedReason = guide && (GUIDE_DONE_DB as readonly string[]).includes(guide.state)
        ? '이미 발송한 안내입니다' : '안내를 먼저 작성하세요';
    } else if (!guide.body?.trim()) {
      sendBlockedCode = 'GUIDE_BODY_EMPTY'; sendBlockedReason = '안내 본문을 먼저 작성하세요';
    } else if (!guide.teacherId) {
      sendBlockedCode = 'GUIDE_RECIPIENT_UNAVAILABLE'; sendBlockedReason = '받는 강사가 지정되지 않았습니다';
    } else if (!recipientEligible) {
      sendBlockedCode = 'GUIDE_RECIPIENT_UNAVAILABLE'; sendBlockedReason = '활동 중인 강사에게만 안내를 발송할 수 있습니다';
    }
    return { canManage, actualTeacher, isRecipient, recipientEligible, canSend: sendBlockedReason === null,
      canAck: isRecipient && guide?.state === 'sent', sendBlockedReason, sendBlockedCode };
  }

  /** 수업 이름표 네 칸 — 한 번/매번/누락 줄이 같은 모양으로 싣는다 (GUIDE_LESSON_JOINS) */
  private static lessonTag(r: R): { subName: string | null; kindName: string | null; startMin: number | null; roomName: string | null } {
    return {
      subName: (r.sub_name as string) ?? null,
      kindName: (r.kind_name as string) ?? null,
      startMin: r.start_min == null ? null : Number(r.start_min),
      roomName: (r.room_name as string) ?? null,
    };
  }

  private mapGuide(r: R, viewer?: RequestUser): GuideDto {
    const pending = (GUIDE_PENDING_DB as readonly string[]).includes(String(r.state));
    const teacherId = r.teacher_id == null ? null : Number(r.teacher_id);
    const body = (r.body as string) ?? null;
    const gate = GuidesService.guideCapabilities(viewer, {
      state: String(r.state), teacherId, body,
      recipientActive: r.recipient_active === true, recipientRole: (r.recipient_role as string) ?? null,
    });
    const siblings = GuidesService.siblingsOf(r.siblings);
    const elapsed = r.sent_at && r.acknowledged_at
      ? (Date.parse(String(r.acknowledged_at)) - Date.parse(String(r.sent_at))) / 1000 : NaN;
    return {
      id: Number(r.id), serId: r.ser_id == null ? null : Number(r.ser_id), studentId: Number(r.student_id),
      teacherId,
      reason: String(r.reason), kindLabel: guideKindLabel(String(r.reason)), state: String(r.state), pending,
      canSend: gate.canSend, canAck: gate.canAck, sendBlockedReason: gate.sendBlockedReason,
      acknowledgedAfterSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed) : null,
      studentName: (r.student_name as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      // 이전 강사 → 받는 강사(교체 강사) — 간이 안내만 · 장부에서 되짚은 값 (TEACHER-LINEAGE)
      previousTeacherId: r.previous_teacher_id == null ? null : Number(r.previous_teacher_id),
      previousTeacherName: (r.previous_teacher_name as string) ?? null,
      serTitle: (r.ser_title as string) ?? null,
      ...GuidesService.lessonTag(r),
      body,
      direction: (r.direction as string) ?? null,
      adminNote: (r.admin_note as string) ?? null,
      dueOn: (r.due_on as string) ?? null,
      eventOn: (r.event_on as string) ?? null,
      sourceOccurrenceId: r.source_occurrence_id == null ? null : Number(r.source_occurrence_id),
      createdBy: r.created_by == null ? null : Number(r.created_by), createdByName: (r.created_by_name as string) ?? null,
      createdAt: String(r.created_at),
      sentBy: r.sent_by == null ? null : Number(r.sent_by), sentByName: (r.sent_by_name as string) ?? null,
      sentAt: (r.sent_at as string) ?? null,
      acknowledgedBy: r.acknowledged_by == null ? null : Number(r.acknowledged_by),
      acknowledgedByName: (r.acknowledged_by_name as string) ?? null,
      acknowledgedAt: (r.acknowledged_at as string) ?? null,
      overdueDays: pending ? overdue(r.due_on as string) : 0,
      // N-89 — 아직 안 보낸 안내만 기한이 있다. 첫 수업 시작(없으면 기한 날 00:00)까지 · 사다리 · 긴급도는 guide-deadline 한 곳
      deadline: pending ? guideDeadline((r.start_at as string) ?? null, (r.due_on as string) ?? null) : null,
      // 「나머지 학생에게 복사」가 서는지도 서버가 센다 (F-61 · D-R37) — 화면이 목록을 다시 훑지 않는다
      siblingCount: siblings.length,
      // 같은 반 학생 — 작성 창이 함께 보낼 학생을 고른다(F-60). 옮길 수 있는가 · 까닭은 복사와 같은 규칙
      siblings,
    };
  }

  /** teacherId 가 있으면 그 강사 것만 — 화면이 안 걸러도 서버가 거른다 (D-R39). */
  async all(teacherId?: number, viewer?: RequestUser): Promise<GuidesDto> {
    const only = teacherId !== undefined;
    const guides = await this.guideRows(`WHERE ($1::bigint IS NULL OR g.teacher_id=$1)`, [only ? teacherId : null], undefined, viewer);

    const today = todayKst();
    const [perLesson, missing] = await Promise.all([
      this.perLessonRows({ drawnOn: today, teacherId: only ? teacherId : null }),
      // §43 「안내 없음」 — §45 누락 카드와 같은 판정, 할 일 창 안의 것만 (g4 §43-2)
      this.candidateRows(
        addDays(today, -TODO_MISSING_BACK_DAYS), addDays(today, TODO_MISSING_AHEAD_DAYS),
        null, null, false, undefined, only ? teacherId! : null,
      ),
    ]);
    const teacherChanges = new Map<string, number>();
    for (const guide of guides.filter((guide) => guide.reason === 'teacher_change')) {
      const key = `${guide.studentId}|${guide.serId ?? 'none'}`;
      teacherChanges.set(key, (teacherChanges.get(key) ?? 0) + 1);
    }
    const stats = {
      monitoring: new Set(guides.map((guide) => guide.studentId)).size,
      // 「마감 초과」 — 6시간 칸을 지난 줄(N-89). 원문 §43 머리의 이 수는 「안내 없음」 줄도 센다(마감 지남 1줄 = 1)
      overdue: guides.filter((guide) => guide.deadline?.urgency === 'overdue').length
        + missing.filter((row) => row.deadline?.urgency === 'overdue').length,
      drafting: guides.filter((guide) => guide.state === 'draft').length,
      sendPending: guides.filter((guide) => guide.state === 'ready').length,
      teacherUnconfirmed: guides.filter((guide) => guide.state === 'sent').length,
      repeatedTeacherChange: [...teacherChanges.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    };
    return {
      guides,
      perLesson,
      missing,
      todoCount:
        guides.filter((g) => g.pending).length +
        missing.length +
        perLesson.filter((notice) => !notice.parentDeliveryRecorded || !notice.teacherDeliveryRecorded).length,
      scopedTeacherId: only ? teacherId! : null,
      stats,
      deliveryCapabilities: (() => {
        const parentExternal = this.sender.ready('email') || this.sender.ready('sms');
        return { parentExternal, teacherExternal: false, reason: parentExternal ? null : PARENT_CHANNELS_OFF };
      })(),
      // §43 매번 머리 「강사 N명 한 번에」 — 회차 줄과 같은 문(sendGate)으로 센다 (wave 6 §43-6)
      zoomBatch: GuidesService.zoomBatchInfo(perLesson, viewer),
    };
  }

  /**
   * 「강사 N명 한 번에」의 N·회차 수·막힌 이유 (wave 6 §43-6 · D-R37 · D-R39).
   *
   * 고르는 것은 줄마다의 `canSendTeacher`(= `sendGate`) 그대로다 — 단추의 N 과 일괄 발송이 실제로 고르는 줄이 같은 문을 지난다.
   * N 은 **사람 수**다(원문 「강사 9명」) — 한 강사가 오늘 온라인 수업 둘이면 한 명으로 센다. 권한 문장은 안내 발송과 같은 말이다.
   */
  private static zoomBatchInfo(perLesson: PerLessonNoticeDto[], viewer?: RequestUser): ZoomNoticeBatchInfoDto {
    const ready = perLesson.filter((row) => row.canSendTeacher);
    const manage = GuidesService.guideCapabilities(viewer);
    let blockedReason: string | null = null;
    if (!manage.canManage) blockedReason = manage.sendBlockedReason;
    else if (perLesson.length === 0) blockedReason = '오늘 온라인 수업이 없습니다';
    else if (ready.length === 0) {
      const left = perLesson.filter((row) => !row.teacherDeliveryRecorded).length;
      blockedReason = left === 0
        ? '오늘 강사 안내를 모두 보냈습니다'
        : `보낼 수 있는 회차가 없습니다 — 남은 ${left}건은 줌 계정이나 강사가 아직 정해지지 않았습니다`;
    }
    return {
      teacherCount: new Set(ready.map((row) => row.teacherId)).size,
      lessonCount: ready.length,
      canSend: blockedReason === null,
      blockedReason,
    };
  }

  /** §44 학생별 — 학생의 최신 GUIDE와 같은 학생의 교재·진단을 한 projection으로 묶는다. */
  async students(viewer?: RequestUser): Promise<GuideStudentsDto> {
    const latest = await this.q(
      `WITH ranked AS (
         SELECT g.*,count(*) OVER (PARTITION BY g.student_id)::int AS guide_count,
                row_number() OVER (PARTITION BY g.student_id ORDER BY g.created_at DESC,g.id DESC) AS rn
           FROM guide g
       )
       SELECT g.id,g.ser_id,g.student_id,g.teacher_id,g.reason,g.state,g.body,g.direction,g.admin_note,g.guide_count,g.created_by,
              ${SIBLINGS_SQL} AS siblings,
              to_char(g.due_on,'YYYY-MM-DD') AS due_on,
              COALESCE(to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD'),to_char(g.event_on,'YYYY-MM-DD')) AS event_on,
              o.id AS source_occurrence_id,${kstAt('lower(o.span)')} AS start_at,${kstAt('g.created_at')} AS created_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by,
              (SELECT sx.name FROM hist h LEFT JOIN staff sx ON sx.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send') AS sent_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by,
              (SELECT sx.name FROM hist h LEFT JOIN staff sx ON sx.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack') AS acknowledged_at,
              st.name AS student_name,st.grade,st.guidance,st.lang,
              t.name AS teacher_name,s.title AS ser_title,cb.name AS created_by_name,
              sb.name AS sub_name,k.name AS kind_name,COALESCE(${START_MIN},s.start_min) AS start_min,rm.name AS room_name,
              t.active AS recipient_active,t.role AS recipient_role,
              pt.id AS previous_teacher_id,pt.name AS previous_teacher_name
         FROM ranked g JOIN stu st ON st.id=g.student_id
         LEFT JOIN staff t ON t.id=g.teacher_id LEFT JOIN ser s ON s.id=g.ser_id
         LEFT JOIN staff cb ON cb.id=g.created_by
         LEFT JOIN ser_occ o ON o.ser_id=g.ser_id AND o.on_date=g.event_on
         ${GUIDE_LESSON_JOINS('s')}
         LEFT JOIN staff pt ON pt.id=${PREVIOUS_TEACHER_SQL('g', 'o')}
        WHERE g.rn=1 ORDER BY st.name,st.id`,
    );
    const ids = latest.map((row) => Number(row.student_id));
    if (ids.length === 0) return { items: [] };
    const books = await this.q(
      `SELECT i.id AS issue_id,i.student_id,i.lib_id,i.vers_id,l.code,l.title,l.se_te,l.sub_key,l.level,l.book_level,v.edition
         FROM issue i JOIN lib l ON l.id=i.lib_id LEFT JOIN vers v ON v.id=i.vers_id
        WHERE i.student_id=ANY($1::bigint[]) AND ${issueActiveSql('i')}
        ORDER BY i.student_id,l.title,i.id`, [ids],
    );
    const diagnostics = await this.q(
      `SELECT DISTINCT ON (d.student_id) d.id,d.student_id,d.level_summary,d.strengths,d.weaknesses,d.curriculum,
              ${kstAt('d.created_at')} AS created_at
         FROM diag d WHERE d.student_id=ANY($1::bigint[])
        ORDER BY d.student_id,d.created_at DESC,d.id DESC`, [ids],
    );
    const items = latest.map((row) => ({
        studentId: Number(row.student_id), studentName: String(row.student_name),
        grade: (row.grade as string) ?? null, guidance: (row.guidance as string) ?? null, lang: (row.lang as string) ?? null,
        guideCount: Number(row.guide_count), latestGuide: this.mapGuide(row, viewer),
        books: books.filter((book) => Number(book.student_id) === Number(row.student_id)).map((book) => ({
          issueId: Number(book.issue_id), libId: Number(book.lib_id),
          versId: book.vers_id === null ? null : Number(book.vers_id), code: String(book.code), title: String(book.title),
          edition: (book.edition as string) ?? null, seTe: (book.se_te as string) ?? null, subKey: (book.sub_key as string) ?? null,
          // §44 교재 줄의 레벨 사각(원문 「P Between the Lines …」) — 서가와 같은 낱말 · 같은 함수(N-47 · W11 A 후속)
          level: bookLevelShown(book.book_level as string | null, book.level as string | null),
        })),
        diagnostic: (() => {
          const diag = diagnostics.find((item) => Number(item.student_id) === Number(row.student_id));
          return diag ? {
            id: Number(diag.id), levelSummary: String(diag.level_summary),
            strengths: (diag.strengths as string) ?? null, weaknesses: (diag.weaknesses as string) ?? null,
            curriculum: (diag.curriculum as string) ?? null, createdAt: String(diag.created_at),
          } : null;
        })(),
      }));
    // §44 도 같은 작성 창을 연다 — 자동 채움이 §43 에만 서면 같은 창이 화면마다 다르게 열린다
    await this.attachAutoFill(items.map((item) => item.latestGuide));
    /*
     * §44 진단 카드 셋 — DQ1 「점수만 저장」의 영어·수학·인터뷰 (g4 §44-2).
     * 상담 진단을 `lead.student_id` 로 따라 읽는 함수 한 벌(ops/lead-diag.service)을 그대로 부른다 — 값을 DIAG 로
     * 옮겨 적지 않는다(D-R22). 학생마다 한 번 묻는다(학생별 화면은 안내가 있는 학생만이라 수가 작다).
     */
    const scores = await Promise.all(items.map((item) => latestLeadDiagForStudent(this.anyRepo.manager, item.studentId)));
    return { items: items.map((item, index) => ({ ...item, scores: scores[index] })) };
  }

  private range(span: GuideHistorySpan, anchor: string): { from: string; to: string } {
    if (!isIsoDate(anchor)) throw new BadRequestException('anchor는 실제 YYYY-MM-DD 날짜여야 합니다');
    if (span === 'day') return { from: anchor, to: anchor };
    if (span === 'week') {
      const dow = new Date(`${anchor}T00:00:00Z`).getUTCDay();
      const from = addDays(anchor, -(dow === 0 ? 6 : dow - 1));
      return { from, to: addDays(from, 6) };
    }
    const from = `${anchor.slice(0, 7)}-01`;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
  }

  private async candidateRows(
    from: string | null,
    to: string | null,
    sourceOccurrenceId: number | null,
    studentId: number | null,
    includeSatisfied: boolean,
    manager?: EntityManager,
    teacherId: number | null = null,
  ): Promise<GuideMissingDto[]> {
    const run = manager
      ? manager.query.bind(manager) as (sql: string, params: unknown[]) => Promise<R[]>
      : (sql: string, params: unknown[]) => this.q(sql, params);
    const rows = await run(
      `${GUIDE_EVENT_CTE}
       SELECT e.source_occurrence_id,e.event_on,e.ser_id,e.student_id,e.student_name,
              e.teacher_id,e.teacher_name,e.ser_title,e.reason,
              e.sub_name,e.kind_name,e.start_min,e.room_name,e.start_at
         FROM events e
        WHERE e.reason IS NOT NULL
          AND ($1::date IS NULL OR e.event_on::date >= $1::date)
          AND ($2::date IS NULL OR e.event_on::date <= $2::date)
          AND ($3::bigint IS NULL OR e.source_occurrence_id=$3)
          AND ($4::bigint IS NULL OR e.student_id=$4)
          AND ($6::bigint IS NULL OR e.teacher_id=$6)
          /* 강사 교체 안내가 첫 수업 안내를 덮는 규칙까지 guide-events.ts 한 곳 */
          AND ($5::boolean OR NOT ${guideCoversEvent()})
        ORDER BY e.event_on DESC,e.source_occurrence_id,e.student_name`,
      [from, to, sourceOccurrenceId, studentId, includeSatisfied, teacherId],
    );
    return rows.map((row) => ({
      sourceOccurrenceId: Number(row.source_occurrence_id), eventOn: String(row.event_on),
      serId: Number(row.ser_id), studentId: Number(row.student_id), studentName: String(row.student_name),
      teacherId: row.teacher_id === null ? null : Number(row.teacher_id),
      teacherName: (row.teacher_name as string) ?? null, serTitle: (row.ser_title as string) ?? null,
      ...GuidesService.lessonTag(row),
      reason: String(row.reason),
      // 안내 기한 = 그 수업 날 (createDraft 가 due_on 을 event_on 으로 둔다)
      overdueDays: overdue(String(row.event_on)),
      // N-89 — 「마감 지남」 · 「오늘 안에」 칩과 사다리는 이 값이다(그 회차 시작까지)
      deadline: guideDeadline((row.start_at as string) ?? null, String(row.event_on)),
    }));
  }

  /**
   * §45 이력 — N-90 채택(W11): **줄 하나 = 사건 하나**(안내 작성 · 발송 · 강사 확인)이고 **그 사건 시각의 KST 날짜**로 묶는다.
   * 사건 원장은 `hist`(entity='guide') 한 곳이다 — 안내의 수업 날·기한·만든 날로 묶던 옛 방식(COALESCE)은 한 안내의 세 사건을
   * 한 날에 겹쳐 적어, 「언제 무엇을 했나」를 답하지 못했다(g4). 기간 · 안 한 것(누락)은 전과 같다.
   * 머리 「N건 만듦 · N건 보냄」은 그 기간의 작성 · 발송 사건 수다 — 날짜 머리의 칩 합과 같은 수(D-R37).
   */
  async history(query: GuideHistoryQueryDto, viewer?: RequestUser): Promise<GuideHistoryDto> {
    const span = query.span ?? 'month';
    const anchor = query.anchor ?? todayKst();
    const { from, to } = this.range(span, anchor);
    const actions = GUIDE_HISTORY_EVENTS.map((event) => event.action);
    const [events, missing] = await Promise.all([
      this.q(
        `SELECT h.id,h.ref_id AS guide_id,h.action,${kstAt('h.at')} AS at,${hhmmOf('h.at')} AS time,
                to_char(${kstDateOf('h.at')},'YYYY-MM-DD') AS date,h.by_id,st.name AS by_name
           FROM hist h
           JOIN guide g ON g.id=h.ref_id
           LEFT JOIN staff st ON st.id=h.by_id
          WHERE h.entity='guide' AND h.action=ANY($3::text[])
            AND ${kstDateOf('h.at')} BETWEEN $1::date AND $2::date
          ORDER BY h.at DESC,h.id DESC`,
        [from, to, actions],
      ),
      this.candidateRows(from, to, null, null, false),
    ]);
    const guideIds = [...new Set(events.map((event) => Number(event.guide_id)))];
    const guides = guideIds.length
      ? await this.guideRows(`WHERE g.id = ANY($1::bigint[])`, [guideIds], undefined, viewer)
      : [];
    const byId = new Map(guides.map((guide) => [guide.id, guide]));
    const stateOf = new Map<string, string>(GUIDE_HISTORY_EVENTS.map((event) => [event.action, event.stateAfter]));
    const grouped = new Map<string, GuideHistoryEventDto[]>();
    for (const row of events) {
      const guide = byId.get(Number(row.guide_id));
      if (!guide) continue;
      const action = String(row.action);
      const item: GuideHistoryEventDto = {
        id: Number(row.id), action, label: histLabel(action), stateAfter: stateOf.get(action)!,
        at: String(row.at), time: String(row.time),
        byId: row.by_id == null ? null : Number(row.by_id), byName: (row.by_name as string) ?? null,
        guide,
      };
      const date = String(row.date);
      grouped.set(date, [...(grouped.get(date) ?? []), item]);
    }
    const days: GuideHistoryDayDto[] = [...grouped.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, dayEvents]) => ({
        date,
        events: dayEvents,
        tally: GUIDE_HISTORY_EVENTS
          .map((event) => ({
            action: event.action, stateAfter: event.stateAfter, label: histLabel(event.action),
            count: dayEvents.filter((item) => item.action === event.action).length,
          }))
          .filter((entry) => entry.count > 0),
      }));
    const countOf = (action: string) => events.filter((row) => String(row.action) === action && byId.has(Number(row.guide_id))).length;
    return {
      span, anchor, from, to, missing, days,
      counts: { created: countOf('guide_write'), sent: countOf('guide_send'), missing: missing.length },
    };
  }

  /** §45 누락 카드 클릭 — 클라이언트 이유를 믿지 않고 현재 SER_OCC에서 다시 판정한다. */
  async createDraft(userId: number, dto: GuideDraftCreateDto, viewer?: RequestUser): Promise<GuideDto> {
    const id = await this.anyRepo.manager.transaction(async (manager) => {
      const occurrences = await manager.query(
        `SELECT ser_id FROM ser_occ WHERE id=$1`, [dto.sourceOccurrenceId],
      ) as Array<{ ser_id: string }>;
      if (!occurrences[0]) throw new ConflictException({ code: 'GUIDE_CANDIDATE_STALE', message: '회차가 더 이상 존재하지 않습니다' });
      /* 일정 쓰기와 같은 부모 잠금 순서. 잠금을 얻은 뒤 이벤트를 다시 계산한다. */
      await manager.query(`SELECT id FROM ser WHERE id=$1 FOR NO KEY UPDATE`, [Number(occurrences[0].ser_id)]);
      const [candidate] = await this.candidateRows(null, null, dto.sourceOccurrenceId, dto.studentId, true, manager);
      if (!candidate) {
        throw new ConflictException({
          code: 'GUIDE_CANDIDATE_STALE',
          message: '현재 회차는 첫 수업 또는 강사 교체 안내 대상이 아닙니다',
        });
      }
      const [source] = await manager.query(
        `SELECT on_date FROM ser_occ WHERE id=$1 AND ser_id=$2`, [dto.sourceOccurrenceId, candidate.serId],
      ) as Array<{ on_date: string }>;
      if (!source) throw new ConflictException({ code: 'GUIDE_CANDIDATE_STALE', message: '회차가 변경되었습니다' });

      const existing = await manager.query(
        `SELECT id FROM guide
          WHERE ser_id=$1 AND event_on=$2::date AND student_id=$3 AND reason=$4
          FOR UPDATE`,
        [candidate.serId, source.on_date, candidate.studentId, candidate.reason],
      ) as Array<{ id: string }>;
      if (existing[0]) return Number(existing[0].id);
      // 강사 교체 초안은 그 학생의 **이전 안내**에서 지도 방향을 물려받는다 (원문 §44 「연동」 · F-62 · TEACHER-LINEAGE)
      // (같은 $4 를 대입과 비교에 함께 쓰면 pg 가 inconsistent types 로 거절한다 — 갈래는 여기서 정한다)
      const inherited = candidate.reason === 'teacher_change' ? INHERITED_DIRECTION_SQL('$2') : 'NULL';
      const made = await manager.query(
        `INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on,created_by,direction)
         VALUES ($1,$2,$3,$4,'draft'::guide_state_t,$5::date,$6::date,$7,${inherited})
         ON CONFLICT (ser_id,event_on,student_id,reason)
           WHERE ser_id IS NOT NULL AND event_on IS NOT NULL DO NOTHING
         RETURNING id`,
        [candidate.serId, candidate.studentId, candidate.teacherId, candidate.reason, candidate.eventOn, source.on_date, userId],
      ) as Array<{ id: string }>;
      if (made[0]) return Number(made[0].id);
      const [won] = await manager.query(
        `SELECT id FROM guide WHERE ser_id=$1 AND event_on=$2::date AND student_id=$3 AND reason=$4`,
        [candidate.serId, source.on_date, candidate.studentId, candidate.reason],
      ) as Array<{ id: string }>;
      if (!won) throw new ConflictException({ code: 'GUIDE_CREATE_RACE', message: '안내 초안 생성 결과를 확인할 수 없습니다' });
      return Number(won.id);
    });
    const [guide] = await this.guideRows(`WHERE g.id=$1`, [id], undefined, viewer);
    if (!guide) throw new NotFoundException('생성한 안내를 찾을 수 없습니다');
    return guide;
  }

  /**
   * 등록 확정(C91)이 같은 트랜잭션에서 부른다 — 방금 만든 규칙의 **첫 수업 안내 초안**을 그 학생에게 남긴다.
   * 판정은 §45 누락 카드와 같은 `candidateRows`(첫 수업·강사 교체) 이고 이미 있는 것은 건너뛴다. 만든 id 를 돌려준다.
   */
  async draftsForStudent(manager: EntityManager, userId: number, studentId: number): Promise<number[]> {
    const candidates = await this.candidateRows(null, null, null, studentId, false, manager);
    const made: number[] = [];
    for (const c of candidates) {
      const [source] = await manager.query(
        `SELECT on_date FROM ser_occ WHERE id=$1 AND ser_id=$2`, [c.sourceOccurrenceId, c.serId],
      ) as Array<{ on_date: string }>;
      if (!source) continue;
      const rows = await manager.query(
        `INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on,created_by)
         VALUES ($1,$2,$3,$4,'draft'::guide_state_t,$5::date,$6::date,$7)
         ON CONFLICT (ser_id,event_on,student_id,reason)
           WHERE ser_id IS NOT NULL AND event_on IS NOT NULL DO NOTHING
         RETURNING id`,
        [c.serId, c.studentId, c.teacherId, c.reason, c.eventOn, source.on_date, userId],
      ) as Array<{ id: string }>;
      if (rows[0]) made.push(Number(rows[0].id));
    }
    return made;
  }

  /**
   * 강사 교체 마법사(C93 · F-62 「강사 교체 시 간이 안내」)가 같은 트랜잭션에서 부른다 —
   * 바뀐 규칙들의 **첫 바뀐 회차**(그날부터)에 그 명단의 학생마다 `teacher_change` 초안 하나. 이유를 CTE 로 되짚지 않는다:
   * 「이 날부터 계속」은 규칙을 가르므로(D-R16) CTE 가 새 규칙의 첫 회차를 「첫 수업」으로 읽는다 — 마법사는 그것이 교체라는 것을 안다.
   * 이미 있으면 건너뛴다(같은 유니크). 만든 id 를 돌려준다.
   *
   * **이전 안내를 물려받는다** (원문 §44 「연동 — 강사 교체 시 이전 안내에서 지도 방향·교재를 물려받습니다」 · F-62 · TEACHER-LINEAGE 2026-09-29):
   * 지도 방향은 그 학생의 **가장 최근 안내**(§44 「가장 최근 안내가 현재 유효한 것」 · 규칙을 가리지 않는다)의 `direction` 을 초안에 복사한다 —
   * 관리자가 작성 창에서 고칠 수 있는 칸이라 저장한다(자동 채움처럼 읽을 때 만들면 「물려받았다」가 저장되지 않는다).
   * 교재는 자동 채움이 그 학생의 지금 교재를 읽으므로(`GUIDE_FACT_SQL`) 따로 복사하지 않는다. 관리자 코멘트는 원문이 말하지 않아 물려주지 않는다.
   * 이전 강사는 새 칸 없이 마법사 LOG 에서 되짚는다(`PREVIOUS_TEACHER_SQL`). 만든 초안마다 `hist(guide · teacher_swap)` 한 줄 —
   * §40 이력의 「강사 교체」 칩(HIST_ACTIONS)의 생산자는 이제 시드가 아니라 마법사다.
   */
  async draftsForTeacherChange(manager: EntityManager, userId: number, serIds: number[], from: string, to: string | null): Promise<number[]> {
    if (!serIds.length) return [];
    const rows = await manager.query(
      `SELECT DISTINCT ON (o.ser_id, ss.student_id)
              o.ser_id, to_char(o.on_date,'YYYY-MM-DD') AS on_date, to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS event_on, o.teacher_id, ss.student_id
         FROM ser_occ o
         JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ${serStuOn('ss', 'o.on_date')}
         LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
        WHERE o.ser_id = ANY($1) AND NOT o.canceled
          AND ${kstDateOf('lower(o.span)')} >= $2::date
          AND ($3::date IS NULL OR ${kstDateOf('lower(o.span)')} <= $3::date)
          AND NOT EXISTS (SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id)
        ORDER BY o.ser_id, ss.student_id, o.on_date, o.id`,
      [serIds, from, to],
    ) as Array<{ ser_id: string; on_date: string; event_on: string; teacher_id: string | null; student_id: string }>;
    const made: number[] = [];
    for (const r of rows) {
      const ins = await manager.query(
        `INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on,created_by,direction)
         VALUES ($1,$2,$3,'teacher_change','draft'::guide_state_t,$4::date,$5::date,$6,${INHERITED_DIRECTION_SQL('$2')})
         ON CONFLICT (ser_id,event_on,student_id,reason)
           WHERE ser_id IS NOT NULL AND event_on IS NOT NULL DO NOTHING
         RETURNING id`,
        [Number(r.ser_id), Number(r.student_id), r.teacher_id === null ? null : Number(r.teacher_id), r.event_on, r.on_date, userId],
      ) as Array<{ id: string }>;
      if (ins[0]) {
        const id = Number(ins[0].id);
        made.push(id);
        await manager.query(histSql(), ['guide', id, 'teacher_swap', userId]);
      }
    }
    return made;
  }

  /* ══ §43 「나머지 학생에게 복사」 (F-61) ═════════════════════════════════════ */

  /**
   * 그룹 수업 안내를 형제 초안으로 옮긴다.
   *
   * **같은 규칙 · 같은 날 · 같은 사유**의 다른 학생 초안만 받는다 — 다른 날의 안내는 다른 사건이다.
   * **이미 쓴 형제는 건너뛴다.** 덮으면 그 사람이 쓴 말이 소리 없이 사라진다.
   * **머리말은 받는 학생 것으로 다시 만든다** — 그대로 옮기면 A 의 이름·학년·교재가 B 의 안내에
   * 남고 그 말이 학부모에게 나간다. 원본이 자기 머리말로 시작할 때만 앞자락을 갈아 끼우고,
   * 사람이 머리말까지 고쳐 써서 앞자락이 안 맞으면 그대로 옮기며 `headReplaced:false` 로 알린다.
   */
  /* ══ F-60 「진단 입력 탭이 인원수만큼」 · F-61 진단 복사 ════════════════════════════════════════════
   * 사용자 결정 2026-09-30 「탭에서 관리자도 입력」 — C61(「진단 리포트 작성 — 강사 가능 · 나머지 조회」)을 안내 작성 창에서 넓힌다.
   * 같은 표(DIAG · 쌓고 · 읽기는 늘 최신 한 줄)에 적는다 — 강사 진단과 두 벌로 가르지 않는다. 쓰는 사람은 안내를 쓰는 사람과 같은
   * 권한(canAdminPage + canCrudAll · 컨트롤러)이고, 받는 학생은 그 안내의 반(같은 규칙 · 같은 날 · 같은 사유의 안내)뿐이다.
   */
  private async classOf(run: (sql: string, p: unknown[]) => Promise<R[]>, id: number): Promise<Array<{ guideId: number; studentId: number; studentName: string | null; serId: number | null }>> {
    const rows = await run(
      `SELECT cg.id AS guide_id, cg.student_id, st.name AS student_name, g.ser_id
         FROM guide g
         JOIN guide cg ON cg.id = g.id OR (cg.ser_id = g.ser_id AND cg.event_on = g.event_on AND cg.reason = g.reason)
         LEFT JOIN stu st ON st.id = cg.student_id
        WHERE g.id = $1
        ORDER BY (cg.id = g.id) DESC, st.name, cg.id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('안내를 찾을 수 없습니다');
    return rows.map((r) => ({
      guideId: Number(r.guide_id), studentId: Number(r.student_id), studentName: (r.student_name as string) ?? null,
      serId: r.ser_id == null ? null : Number(r.ser_id),
    }));
  }

  private async classDiagRows(run: (sql: string, p: unknown[]) => Promise<R[]>, id: number): Promise<GuideClassDiagListDto> {
    const members = await this.classOf(run, id);
    const diags = await run(
      `SELECT DISTINCT ON (d.student_id) d.id, d.student_id, d.level_summary, d.strengths, d.weaknesses, d.curriculum,
              ${kstAt('d.created_at')} AS created_at
         FROM diag d WHERE d.student_id = ANY($1::bigint[])
        ORDER BY d.student_id, d.created_at DESC, d.id DESC`,
      [members.map((x) => x.studentId)],
    );
    return {
      items: members.map((x) => {
        const d = diags.find((row) => Number(row.student_id) === x.studentId);
        return {
          guideId: x.guideId, studentId: x.studentId, studentName: x.studentName,
          diagnostic: d ? {
            id: Number(d.id), levelSummary: String(d.level_summary),
            strengths: (d.strengths as string) ?? null, weaknesses: (d.weaknesses as string) ?? null,
            curriculum: (d.curriculum as string) ?? null, createdAt: String(d.created_at),
          } : null,
        };
      }),
    };
  }

  /** 반 진단 읽기 — 안내의 학생이 먼저 · 나머지는 이름 차례 · 최신 진단 한 줄씩 */
  classDiagnostics(id: number): Promise<GuideClassDiagListDto> {
    return this.classDiagRows((sql, p) => this.q(sql, p), id);
  }

  /**
   * 반 진단 쓰기 — 여러 학생을 한 트랜잭션에 적는다(F-61 「이 내용을 나머지 2명에게 복사」 뒤 각자 고친 값 그대로).
   * 반 밖 학생이 하나라도 있으면 400 GUIDE_DIAG_NOT_CLASS · 현재 수준이 비면 409 EMPTY_BODY(강사 진단과 같은 코드) — 아무것도 쓰지 않는다.
   * 회차 맥락(ser_id)은 그 안내의 수업이다. 흔적은 DIAG 행 자체(created_by · created_at)다 — 강사 진단과 같다.
   */
  async writeClassDiagnostics(userId: number, id: number, dto: GuideClassDiagWriteDto): Promise<GuideClassDiagListDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const run = (sql: string, p: unknown[]) => m.query(sql, p) as Promise<R[]>;
      const members = await this.classOf(run, id);
      const inClass = new Set(members.map((x) => x.studentId));
      if (dto.items.some((x) => !inClass.has(x.studentId))) {
        throw new BadRequestException({ code: 'GUIDE_DIAG_NOT_CLASS', message: '이 안내의 반 학생이 아닌 학생이 있습니다 — 아무것도 적지 않았습니다' });
      }
      const trimmed = (v: string | undefined): string | null => { const t = v?.trim(); return t ? t : null; };
      for (const x of dto.items) {
        if (!x.levelSummary.trim()) throw new ConflictException({ code: 'EMPTY_BODY', message: '현재 수준을 적어 주세요' });
      }
      const serId = members[0]!.serId;
      for (const x of dto.items) {
        await m.query(
          `INSERT INTO diag (student_id, ser_id, level_summary, strengths, weaknesses, curriculum, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [x.studentId, serId, x.levelSummary.trim(), trimmed(x.strengths), trimmed(x.weaknesses), trimmed(x.curriculum), userId],
        );
      }
      return this.classDiagRows(run, id);
    });
  }

  async copyBody(userId: number, id: number, viewer?: RequestUser, targetIds?: number[]): Promise<GuideCopyResultDto> {
    const copiedIds: number[] = [];
    const skipped: GuideCopyResultDto['skipped'] = [];
    let headReplaced = false;

    await this.anyRepo.manager.transaction(async (m) => {
      const [src] = await m.query(
        /* 날짜는 문자열로 받는다 — Date 를 그대로 되돌려주면 파라미터로 다시 넣을 때 깨진다 */
        `SELECT g.id, g.ser_id, to_char(g.event_on,'YYYY-MM-DD') AS event_on, g.reason, g.body, g.state
           FROM guide g WHERE g.id=$1 FOR UPDATE`,
        [id],
      ) as Array<R>;
      if (!src) throw new NotFoundException('안내를 찾을 수 없습니다');
      const body = (src.body as string | null) ?? '';
      if (body.trim() === '') {
        throw new ConflictException({
          code: 'GUIDE_COPY_EMPTY',
          message: '먼저 이 학생의 안내를 쓴 뒤에 복사하세요',
        });
      }
      if (src.ser_id === null || src.event_on === null) {
        throw new ConflictException({
          code: 'GUIDE_COPY_NO_SIBLING',
          message: '이 안내는 수업 회차에 붙어 있지 않아 옮길 곳이 없습니다',
        });
      }

      /* 형제 — 같은 규칙·같은 날·같은 사유의 다른 학생. 상태와 무관하게 전부 가져와 이유를 돌려준다 */
      const siblings = await m.query(
        `SELECT g.id, g.state, st.name AS student_name
           FROM guide g LEFT JOIN stu st ON st.id=g.student_id
          WHERE g.ser_id=$1 AND g.event_on=$2::date AND g.reason=$3 AND g.id<>$4
          ORDER BY st.name, g.id
          FOR UPDATE OF g`,
        [Number(src.ser_id), String(src.event_on), String(src.reason), id],
      ) as Array<R>;
      if (siblings.length === 0) {
        throw new ConflictException({
          code: 'GUIDE_COPY_NO_SIBLING',
          message: '이 수업에는 같은 날 안내를 받는 다른 학생이 없습니다',
        });
      }
      /*
        작성 창에서 고른 학생만 받는다(F-60 · all160 2026-09-30) — 안 고르면 형제 전부(F-61 그대로).
        형제가 아닌 번호가 섞이면 **아무것도 쓰기 전에** 거절한다 — 다른 수업의 초안에 본문이 들어가면 남의 학부모에게 간다.
      */
      const siblingIds = new Set(siblings.map((sib) => Number(sib.id)));
      if (targetIds !== undefined && targetIds.some((t) => !siblingIds.has(t))) {
        throw new BadRequestException({
          code: 'GUIDE_COPY_NOT_SIBLING',
          message: '같은 수업 같은 날의 다른 학생 안내에만 옮길 수 있습니다',
        });
      }
      const wanted = targetIds === undefined ? null : new Set(targetIds);

      /* 원본 머리말 — 이 앞자락으로 시작할 때만 갈아 끼운다 */
      const srcFill = await guideAutoFill(m, id);
      const srcHead = srcFill?.body ?? '';
      const hasHead = srcHead !== '' && body.startsWith(srcHead);
      const tail = hasHead ? body.slice(srcHead.length) : body;
      headReplaced = hasHead;

      for (const sib of siblings) {
        const sibId = Number(sib.id);
        if (wanted && !wanted.has(sibId)) continue;
        const name = (sib.student_name as string) ?? '이름 없음';
        if (String(sib.state) !== 'draft') {
          skipped.push({ id: sibId, studentName: name, reason: GuidesService.copySkipReason(String(sib.state)) });
          continue;
        }
        const head = hasHead ? (await guideAutoFill(m, sibId))?.body ?? '' : '';
        const next = hasHead ? head + tail : tail;
        const rows = writtenRows<R>(await m.query(
          `UPDATE guide SET body=$2,state='ready'::guide_state_t
            WHERE id=$1 AND state='draft'::guide_state_t RETURNING id`,
          [sibId, next],
        ));
        if (!rows[0]) {
          skipped.push({ id: sibId, studentName: name, reason: '그 사이에 상태가 바뀌었습니다' });
          continue;
        }
        await m.query(histSql(), ['guide', sibId, 'guide_write', userId]);
        copiedIds.push(sibId);
      }
    });

    const copied = copiedIds.length
      ? await this.guideRows(`WHERE g.id = ANY($1::bigint[])`, [copiedIds], undefined, viewer)
      : [];
    return { copied, skipped, headReplaced };
  }

  /** 형제 안내 줄 — 옮길 수 있는가(초안만)와 까닭은 복사가 건너뛰는 규칙과 같은 함수다 */
  private static siblingsOf(raw: unknown): GuideDto['siblings'] {
    const rows = Array.isArray(raw) ? raw as Array<{ id: unknown; studentName: unknown; state: unknown }> : [];
    return rows.map((x) => {
      const state = String(x.state);
      const copyable = state === 'draft';
      return {
        id: Number(x.id), studentName: (x.studentName as string | null) ?? null, state,
        copyable, skipReason: copyable ? null : GuidesService.copySkipReason(state),
      };
    });
  }

  /** 왜 건너뛰었는지 — 낱말은 여기 하나다 (D-R18) */
  private static copySkipReason(state: string): string {
    if (state === 'ready') return '이미 쓴 안내라 덮지 않았습니다';
    if (state === 'sent') return '이미 보낸 안내입니다';
    if (state === 'read') return '강사가 확인한 안내입니다';
    return `상태가 ${state} 라 옮기지 않았습니다`;
  }

  /* ══ §43 회차 안내의 「강사 안내」 — 줌 안내 (F-63) ══════════════════════════ */

  /**
   * 단추가 서는지와 실제로 보낼 수 있는지를 **같은 함수**가 정한다 (D-R39 · D-R22).
   * 화면이 「온라인인가 · 줌 계정이 있는가」를 다시 보면 눌리는데 거절당하는 단추가 생긴다.
   */
  private static sendGate(f: { alreadySent: boolean; zaccId: number | null; teacherId: number | null }):
    { canSendTeacher: boolean; sendBlockedReason: string | null; sendBlockedCode: string | null } {
    /* 코드도 여기 한 곳이다 — 단건 쓰기의 409 와 일괄 발송의 「건너뜀」 줄이 같은 코드를 쓴다 (wave 6 §43-6) */
    if (f.alreadySent) return { canSendTeacher: false, sendBlockedReason: '이미 보냈습니다', sendBlockedCode: 'ZOOM_NOTICE_ALREADY' };
    if (f.teacherId === null) return { canSendTeacher: false, sendBlockedReason: '강사가 아직 정해지지 않았습니다', sendBlockedCode: 'ZOOM_NOTICE_NO_TEACHER' };
    if (f.zaccId === null) return { canSendTeacher: false, sendBlockedReason: '줌 계정이 아직 배정되지 않았습니다', sendBlockedCode: 'ZOOM_NOTICE_NO_ACCOUNT' };
    return { canSendTeacher: true, sendBlockedReason: null, sendBlockedCode: null };
  }

  /**
   * 온라인 회차의 줌 안내를 남긴다.
   *
   * **강사 수신함에는 줄이 남는다** — 내부 사용자라 NOTI 한 건이 그 사람 앞으로 선다. 그래서
   * `pnoti.sent_at` 을 찍는다. 다만 **강사 화면에는 아직 §16 알림 칸이 없다**(N-26 · 열린 안건) —
   * 기록까지가 참이고 화면은 그 안건이 닫힐 때 붙는다. 지금 적어 두지 않으면 다음 사람이
   * 「보냈는데 왜 안 보이나」를 처음부터 다시 조사한다.
   * **학부모에게는 보낼 곳이 없다**(STU 에 수신처 칸이 없다 · N-42) —
   * 줄은 「보낼 것」으로 남기고 `sent_at` 은 비운다. 「없음」은 안 보낸 것이 아니라 보낼 대상이
   * 없다는 뜻이고, §12 준비 아홉째 줄이 그렇게 적고 있다.
   *
   * 회차 키는 `(ser_id, on_date)` 다. 투영을 읽기 전에 **부모 SER 를 먼저 잠근다** — 그 사이에
   * 재투영이 돌면 옛 행을 기다리다 잘못된 404 를 낸다(D3-g2a 가 출결에서 고친 그 자리).
   * 두 번째 요청은 `pnoti_teacher_once` 부분 유니크가 막는다 — 앱이 다시 세지 않는다.
   *
   * **비밀번호는 본문에 넣지 않는다.** `zacc.meeting_pw_enc` 는 암호화해 둔 값이고 PNOTI 는
   * 평문 `text` 다 — 옮기면 암호화가 없던 일이 된다.
   */
  async sendZoomNotice(userId: number, dto: ZoomNoticeWriteDto): Promise<ZoomNoticeResultDto> {
    const { teacherNotices, parentNotices } = await this.recordZoomNotice(userId, dto);

    /* 목록과 같은 함수로 그 회차를 다시 읽는다 — **방금 쓴 키 그대로** 집는다(옮긴 회차도 찾는다) */
    const rows = await this.perLessonRows({ serId: dto.serId, onDate: dto.onDate });
    const lesson = rows.find((row) => row.serId === dto.serId);
    if (!lesson) throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: '해당 회차를 찾을 수 없습니다' });
    return { lesson, teacherNotices, parentNotices };
  }

  /**
   * §43 매번 머리 「강사 N명 한 번에」 (원문 §43 · wave 6 §43-6).
   *
   * 오늘 온라인 회차 중 **지금 보낼 수 있는 줄**(`sendGate` — 목록의 `canSendTeacher` 와 같은 문)만 골라 단건 줌 안내와
   * **같은 쓰기**(`recordZoomNotice`)로 한 줄씩 보낸다. 줄마다 제 트랜잭션이다 — 한 줄이 거절돼도 이미 보낸 줄과
   * 뒤의 줄은 되돌아가지 않는다(단건 쓰기의 원자 단위 그대로). 목록을 읽은 뒤 그 사이 남이 먼저 보냈거나 회차가
   * 바뀐 줄은 쓰기가 다시 판정해 거절하고, 그 **서버 코드·문장 그대로** 「건너뜀」에 싣는다. 처음부터 막힌 줄
   * (이미 보냄 · 강사/계정 없음)도 같은 문의 이유로 싣는다. 예상 밖 오류(4xx 가 아닌 것)는 삼키지 않고 던진다 —
   * 그때까지 보낸 줄은 커밋돼 있고 화면은 목록을 다시 읽어 사실을 본다.
   */
  async sendZoomNoticeBatch(viewer: RequestUser): Promise<ZoomNoticeBatchResultDto> {
    // 가드(@Perm) 뒤의 두 번째 문 — 안내 발송과 같은 판정(canAdminPage·canCrudAll)
    if (!GuidesService.guideCapabilities(viewer).canManage) throw new ForbiddenException('안내를 발송할 권한이 없습니다');
    const rows = await this.perLessonRows({ drawnOn: todayKst(), teacherId: null });
    const sent: ZoomNoticeBatchRowDto[] = [];
    const skipped: ZoomNoticeBatchRowDto[] = [];
    let parentNotices = 0;
    for (const row of rows) {
      const base = {
        serId: row.serId, onDate: row.onDate, startMin: row.startMin,
        teacherId: row.teacherId ?? null, teacherName: row.teacherName ?? null,
        studentNames: row.notices.map((notice) => notice.studentName).join(', '),
      };
      const gate = GuidesService.sendGate({
        alreadySent: row.teacherDeliveryRecorded, zaccId: row.zaccId ?? null, teacherId: row.teacherId ?? null,
      });
      if (!gate.canSendTeacher) {
        skipped.push({ ...base, code: gate.sendBlockedCode, reason: gate.sendBlockedReason });
        continue;
      }
      try {
        const done = await this.recordZoomNotice(viewer.id, { serId: row.serId, onDate: row.onDate });
        parentNotices += done.parentNotices;
        sent.push({ ...base, code: null, reason: null });
      } catch (error) {
        const refusal = GuidesService.refusalOf(error);
        if (!refusal) throw error;
        skipped.push({ ...base, ...refusal });
      }
    }
    return { sent, skipped, teacherCount: new Set(sent.map((row) => row.teacherId)).size, parentNotices };
  }

  /** 쓰기가 거절한 까닭(409 · 404)을 코드·문장으로 — 그 밖의 오류는 null(던진다) */
  private static refusalOf(error: unknown): { code: string | null; reason: string } | null {
    if (!(error instanceof ConflictException) && !(error instanceof NotFoundException)) return null;
    const body = error.getResponse() as { code?: string; message?: string | string[] } | string;
    if (typeof body === 'string') return { code: null, reason: body };
    const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    return { code: body.code ?? null, reason: message ?? error.message };
  }

  /**
   * 줌 안내 한 회차를 **한 트랜잭션**으로 남긴다 — 단건(`sendZoomNotice`)과 일괄(`sendZoomNoticeBatch`)이 같은 쓰기를 쓴다.
   * 판정(온라인 · 휴강 · sendGate)과 부모 SER 잠금·부분 유니크(pnoti_teacher_once)가 모두 여기 있다.
   */
  private async recordZoomNotice(userId: number, dto: ZoomNoticeWriteDto): Promise<{ teacherNotices: number; parentNotices: number }> {
    let teacherNotices = 0;
    let parentNotices = 0;

    await this.anyRepo.manager.transaction(async (m) => {
      await m.query(`SELECT id FROM ser WHERE id=$1 FOR NO KEY UPDATE`, [dto.serId]);
      const [occ] = await m.query(
        `SELECT o.ser_id, o.on_date, o.canceled, o.teacher_id, o.zacc_id,
                ${effectiveModeOf('x', 'r')} AS mode, r.title AS ser_title,
                k.name AS kind_name, t.name AS teacher_name,
                z.label AS zacc_label, z.join_url, z.meeting_id,
                to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS drawn_date,
                ${START_MIN} AS start_min, ${END_MIN} AS end_min
           FROM ser_occ o
           JOIN ser r ON r.id=o.ser_id
           JOIN kind k ON k.key=r.kind_key
           -- 회차의 실제 방식 — 그 회차만 바꾼 예외(exc.mode)가 이긴다 (N-56)
           LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
           LEFT JOIN staff t ON t.id=o.teacher_id
           LEFT JOIN zacc z ON z.id=o.zacc_id
          WHERE o.ser_id=$1 AND o.on_date=$2::date`,
        [dto.serId, dto.onDate],
      ) as Array<R>;
      if (!occ) throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: '해당 회차를 찾을 수 없습니다' });
      if (String(occ.mode) !== 'online') {
        throw new ConflictException({ code: 'ZOOM_NOTICE_NOT_ONLINE', message: '현장 수업에는 줌 안내가 없습니다' });
      }
      if (occ.canceled === true) {
        throw new ConflictException({ code: 'ZOOM_NOTICE_CANCELED', message: '휴강한 회차에는 줌 안내를 보내지 않습니다' });
      }
      const gate = GuidesService.sendGate({
        alreadySent: false,
        zaccId: occ.zacc_id == null ? null : Number(occ.zacc_id),
        teacherId: occ.teacher_id == null ? null : Number(occ.teacher_id),
      });
      if (!gate.canSendTeacher) {
        throw new ConflictException({
          code: gate.sendBlockedCode,
          message: gate.sendBlockedReason ?? '줌 안내를 보낼 수 없습니다',
        });
      }

      const when = `${String(occ.drawn_date)} ${GuidesService.hm(Number(occ.start_min))}–${GuidesService.hm(Number(occ.end_min))}`;
      const lesson = (occ.ser_title as string | null) ?? (occ.kind_name as string | null) ?? '수업';
      const account = (occ.zacc_label as string | null) ?? '';
      const meeting = (occ.meeting_id as string | null) ?? null;
      /* 비밀번호는 싣지 않는다 — 암호화 저장을 평문으로 옮기지 않는다 */
      const body = [
        `[줌 안내] ${lesson}`,
        `일시 ${when}`,
        `계정 ${account}`,
        meeting ? `회의 ID ${meeting}` : null,
        `참가 ${String(occ.join_url ?? '')}`,
      ].filter((line) => line !== null).join('\n');

      const teacherRows = await m.query(
        `INSERT INTO pnoti (ser_id, on_date, audience, staff_id, channel, body, sent_at)
         VALUES ($1, $2::date, 'teacher', $3, 'app', $4, now())
         ON CONFLICT DO NOTHING RETURNING id`,
        [dto.serId, dto.onDate, Number(occ.teacher_id), body],
      ) as Array<{ id: string }>;
      if (!teacherRows[0]) {
        throw new ConflictException({ code: 'ZOOM_NOTICE_ALREADY', message: '이 회차의 줌 안내는 이미 보냈습니다' });
      }
      teacherNotices = 1;

      /* 학부모 줄 — 보낼 것으로 남는다(N-42). 이미 남겨 둔 줄은 다시 만들지 않는다 */
      const parentRows = await m.query(
        `INSERT INTO pnoti (ser_id, on_date, audience, student_id, channel, body)
         SELECT $1, $2::date, 'parent', ss.student_id, 'app', $3
           FROM ser_stu ss
           JOIN ser_occ o ON o.ser_id=ss.ser_id AND o.on_date=$2::date
           LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
          WHERE ss.ser_id=$1 AND ${serStuOn('ss', '$2::date')}
            AND NOT EXISTS (SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id)
            AND NOT EXISTS (
              SELECT 1 FROM pnoti p
               WHERE p.ser_id=$1 AND p.on_date=$2::date AND p.audience='parent'
                 AND p.student_id=ss.student_id AND p.body=$3)
         RETURNING id`,
        [dto.serId, dto.onDate, body],
      ) as Array<{ id: string }>;
      parentNotices = parentRows.length;

      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title) VALUES ($1, $2, $3, '/teacher', 'schedule', $4)`,
        [Number(occ.teacher_id), userId, `줌 안내 — ${lesson} · ${when} · ${account}`, NOTI_TITLE.zoomGuide],
      );
      await m.query(histSql(), ['pnoti', Number(teacherRows[0].id), 'guide_send', userId]);
    });
    return { teacherNotices, parentNotices };
  }

  /** 「09:30」 — 안내 본문의 시각 한 곳 */
  private static hm(min: number): string {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }

  /* ══ §43 머리의 「문구 관리」 — 문구 틀 (C51) ═══════════════════════════════ */

  async templates(): Promise<GuideTemplateDto[]> {
    const rows = await this.q(`SELECT id, name, body FROM gtpl ORDER BY name`);
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), body: String(r.body) }));
  }

  /**
   * 틀을 하나 만든다. **이름이 겹치면 막는다** — 목록에서 이름으로 고르는데
   * 같은 이름이 둘이면 어느 것을 골랐는지 화면이 말할 수 없다.
   * N-73(W11) — 만들기 · 고치기는 감사 원장(`guide.template`)에 **같은 트랜잭션으로** 한 줄. 409 로 막히면 줄도 없다.
   */
  async createTemplate(dto: GuideTemplateWriteDto, actorId: number): Promise<GuideTemplateDto> {
    const name = dto.name.trim();
    return this.anyRepo.manager.transaction(async (m) => {
      const dup = await m.query(`SELECT id FROM gtpl WHERE name = $1`, [name]) as R[];
      if (dup.length > 0) {
        throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
      }
      let made: R;
      try {
        [made] = await m.query(
          `INSERT INTO gtpl (name, body) VALUES ($1, $2) RETURNING id, name, body`, [name, dto.body],
        ) as R[];
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
        }
        throw error;
      }
      await audit(m, 'guide.template', {
        actorId, entityId: Number(made.id), action: 'create', after: { name: String(made.name), body: String(made.body) },
      });
      return { id: Number(made.id), name: String(made.name), body: String(made.body) };
    });
  }

  /**
   * 틀을 고친다. **이미 쓴 안내는 안 바뀐다** — 안내는 본문을 복사해 갖고 있다.
   * 보낸 말이 나중에 달라지면 안 되기 때문이고, 그래서 `guide` 에 `gtpl_id` 가 없다.
   */
  async patchTemplate(id: number, dto: GuideTemplateWriteDto, actorId: number): Promise<GuideTemplateDto> {
    const name = dto.name.trim();
    return this.anyRepo.manager.transaction(async (m) => {
      const dup = await m.query(`SELECT id FROM gtpl WHERE name = $1 AND id <> $2`, [name, id]) as R[];
      if (dup.length > 0) {
        throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
      }
      const [before] = await m.query(`SELECT name, body FROM gtpl WHERE id = $1 FOR UPDATE`, [id]) as R[];
      if (!before) throw new NotFoundException('문구를 찾을 수 없습니다');
      let rows: R[];
      try {
        rows = await m.query(
          `UPDATE gtpl SET name = $2, body = $3 WHERE id = $1 RETURNING id, name, body`, [id, name, dto.body],
        ) as R[];
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
        }
        throw error;
      }
      const [row] = writtenRows<R>(rows);
      if (!row) throw new NotFoundException('문구를 찾을 수 없습니다');
      await audit(m, 'guide.template', {
        actorId, entityId: id, action: 'patch',
        before: { name: String(before.name), body: String(before.body) },
        after: { name: String(row.name), body: String(row.body) },
      });
      return { id: Number(row.id), name: String(row.name), body: String(row.body) };
    });
  }

  /* ══ §43 「안내 작성」 (C51) ═══════════════════════════════════════════════ */

  /**
   * 안내 본문을 쓴다 — 쓰면 **보낼 준비**가 된다.
   *
   * 상태 낱말은 화면이 정하지 않는다(D-R18). 화면은 「썼다」만 말하고 어느 상태가 되는지는
   * 여기가 정한다. 이미 보낸 안내는 **고치지 않는다** — 학부모가 받은 말과 장부가 갈린다.
   * 되돌리기가 필요하면 새 안내를 만드는 것이 원문의 방식이다(§53 규칙 줄과 같은 결).
   */
  async writeBody(userId: number, id: number, dto: GuideBodyDto, viewer?: RequestUser): Promise<GuidesDto['guides'][number]> {
    /*
     * 상태 판정도 행 잠금 뒤 **같은 트랜잭션**에서 한다. 발송과 동시에 쓰기가 들어와도
     * sent/read를 ready로 되돌리지 않는다. 이력도 같은 트랜잭션에서 남긴다.
     * 밖에서 남기면 쓰기는 되돌아가고 이력만 남아 「하지도 않은 일」이 장부에 찍힌다.
     */
    await this.anyRepo.manager.transaction(async (m) => {
      const [cur] = await m.query(`SELECT id,state FROM guide WHERE id=$1 FOR UPDATE`, [id]) as Array<{ id: string; state: string }>;
      if (!cur) throw new NotFoundException('안내를 찾을 수 없습니다');
      if ((GUIDE_DONE_DB as readonly string[]).includes(cur.state)) {
        throw new ConflictException({
          code: 'GUIDE_ALREADY_SENT',
          message: '이미 보낸 안내는 고칠 수 없습니다 — 새 안내를 만드세요',
        });
      }
      /*
       * §44 두 상자(지도 방향 · 관리자 코멘트)는 **보낸 칸만** 바꾼다 — 안 보낸 칸(undefined)은 그대로,
       * 빈 글자·null 은 비운다 (g4 §44-3). 본문과 같은 잠금·같은 트랜잭션이라 보낸 안내는 셋 다 못 고친다.
       */
      const tidy = (value: string | null | undefined) => (value == null ? null : value.trim() || null);
      const rows = writtenRows<R>(await m.query(
        `UPDATE guide SET body=$2,state='ready'::guide_state_t,
                direction=CASE WHEN $4::boolean THEN $5::text ELSE direction END,
                admin_note=CASE WHEN $6::boolean THEN $7::text ELSE admin_note END
          WHERE id=$1 AND state=ANY($3::guide_state_t[]) RETURNING id`,
        [id, dto.body, [...GUIDE_PENDING_DB],
          dto.direction !== undefined, tidy(dto.direction), dto.adminNote !== undefined, tidy(dto.adminNote)],
      ));
      if (!rows[0]) throw new ConflictException({ code: 'GUIDE_STATE_CHANGED', message: '안내 상태가 변경되었습니다' });
      await m.query(histSql(), ['guide', id, 'guide_write', userId]);
    });
    const [found] = await this.guideRows(`WHERE g.id=$1`, [id], undefined, viewer);
    if (!found) throw new NotFoundException('안내를 찾을 수 없습니다');
    return found;
  }

  private static assertGuideId(id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('안내 id는 양의 안전정수여야 합니다');
  }

  /** 내부 전달은 GUIDE 수신자를 유지한다. 외부 발송과 PNOTI는 건드리지 않는다. */
  async sendGuide(viewer: RequestUser, id: number): Promise<GuideDto> {
    if (!GuidesService.guideCapabilities(viewer).canManage) throw new ForbiddenException('안내를 발송할 권한이 없습니다');
    GuidesService.assertGuideId(id);
    return this.anyRepo.manager.transaction(async (m) => {
      const [guide] = await m.query('SELECT id,state,teacher_id,body FROM guide WHERE id=$1 FOR UPDATE', [id]) as R[];
      if (!guide) throw new NotFoundException('안내를 찾을 수 없습니다');
      // 이미 전달된 안내는 수신자 활동 상태가 바뀌었어도 다시 발송하거나 과거 이력을 채우지 않는다.
      if (!(GUIDE_DONE_DB as readonly string[]).includes(String(guide.state))) {
        const recipients = guide.state === 'ready' && guide.teacher_id != null
          ? await m.query('SELECT id,active,role FROM staff WHERE id=$1 FOR SHARE', [guide.teacher_id]) as R[] : [];
        const gate = GuidesService.guideCapabilities(viewer, {
          state: String(guide.state), teacherId: guide.teacher_id == null ? null : Number(guide.teacher_id),
          body: (guide.body as string) ?? null, recipientActive: recipients[0]?.active === true,
          recipientRole: (recipients[0]?.role as string) ?? null,
        });
        if (!gate.canSend) throw new ConflictException({ code: gate.sendBlockedCode, message: gate.sendBlockedReason });
        const changed = writtenRows<R>(await m.query(`UPDATE guide SET state='sent' WHERE id=$1 AND state='ready' RETURNING id`, [id]));
        if (!changed[0]) throw new ConflictException({ code: 'GUIDE_STATE_CHANGED', message: '안내 상태가 변경되었습니다' });
        await m.query(histSql(), ['guide', id, 'guide_send', viewer.id]);
        await m.query(`INSERT INTO noti(to_id,from_id,body,link,category,title) VALUES ($1,$2,$3,$4,'schedule',$5)`,
          [guide.teacher_id, viewer.id, '수업 안내가 도착했습니다', `/teacher/guides?guideId=${id}`, NOTI_TITLE.guideArrived]);
      }
      const [result] = await this.guideRows('WHERE g.id=$1', [id], m, viewer);
      if (!result) throw new NotFoundException('안내를 찾을 수 없습니다');
      return result;
    });
  }

  /** 현재 담당 학생 자료와 분리된, 저장된 수신자 본인의 sent/read 안내만 읽는다. */
  async receivedGuides(viewer: RequestUser): Promise<ReceivedGuidesDto> {
    if (!GuidesService.guideCapabilities(viewer).actualTeacher) throw new ForbiddenException('강사 전용 화면입니다');
    return { items: await this.guideRows('WHERE g.teacher_id=$1 AND g.state=ANY($2::guide_state_t[])',
      [viewer.id, [...GUIDE_DONE_DB]], undefined, viewer) };
  }

  /** 확인은 수신 강사 본인만 한다. 알림 열람과 별개이며 중복 확인은 새 이력을 만들지 않는다. */
  async acknowledgeGuide(viewer: RequestUser, id: number): Promise<GuideDto> {
    if (!GuidesService.guideCapabilities(viewer).actualTeacher) throw new ForbiddenException('강사 전용 화면입니다');
    GuidesService.assertGuideId(id);
    return this.anyRepo.manager.transaction(async (m) => {
      const [guide] = await m.query('SELECT id,state,teacher_id,body FROM guide WHERE id=$1 AND teacher_id=$2 FOR UPDATE', [id, viewer.id]) as R[];
      if (!guide) throw new NotFoundException('안내를 찾을 수 없습니다');
      if (guide.state !== 'read') {
        const gate = GuidesService.guideCapabilities(viewer, {
          state: String(guide.state), teacherId: Number(guide.teacher_id), body: (guide.body as string) ?? null,
          recipientActive: true, recipientRole: viewer.role,
        });
        if (!gate.canAck) throw new ConflictException({ code: 'GUIDE_NOT_SENT', message: '발송된 안내만 확인할 수 있습니다' });
        const changed = writtenRows<R>(await m.query(`UPDATE guide SET state='read' WHERE id=$1 AND state='sent' RETURNING id`, [id]));
        if (!changed[0]) throw new ConflictException({ code: 'GUIDE_STATE_CHANGED', message: '안내 상태가 변경되었습니다' });
        await m.query(histSql(), ['guide', id, 'guide_ack', viewer.id]);
      }
      const [result] = await this.guideRows('WHERE g.id=$1 AND g.teacher_id=$2', [id, viewer.id], m, viewer);
      if (!result) throw new NotFoundException('안내를 찾을 수 없습니다');
      return result;
    });
  }

}
