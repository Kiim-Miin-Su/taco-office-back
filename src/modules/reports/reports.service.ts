/** @file-guide
 * 목적: reports.service.ts — ReportsService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import {
  LATE_REPORT_TIERS, REPORT_ACTION_REQUIRED_CANDIDATE_DB, REPORT_FIELDS,
  canExportReport, decodeReportPng, effectiveRepStateFromEnded, isWrittenDbState, reportBodyIssue,
  needsReportActionDbState, reportDeliveryIssue, reportPlainText, reportPngFileName, reportReminderIssue,
  reportReviewIssue, reportWriteIssue, tierFor,
  type RepStateDb, type ReportBody, type ReportDeliveryIssue, type ReportPngIssue,
  type ReportReminderIssue, type ReportReviewIssue, type ReportWriteAction, type ReportWriteIssue,
} from '../../lib/rules';
import { END_MIN, START_MIN, effectiveModeOf, kstAt, kstDateOf } from '../../lib/sql';
import { roleLabel } from '../../lib/role-words';
import { NOTI_TITLE } from '../../lib/noti';
import { audit } from '../../lib/audit';
import type {
  ReportDeliveryCreateDto, ReportDeliveryQueueDto, ReportDetailDto, ReportQueryDto,
  ReportReminderCreateDto, ReportReminderResultDto, ReportReviewDto, ReportRowDto,
  ReportSendGroupDto, ReportSendHistoryDto, ReportSendHistoryListDto, ReportSendSpan, ReportUpsertDto, UnwrittenDto,
  WeeklyBundleDto, WeeklyBundleListDto, WeeklySummaryWriteDto,
} from './reports.dto';
import { REPORT_FILE_STORE, type ReportFileStore } from './report-file.store';
import { REPORT_CANCELED_SQL, REPORT_DATE_SQL } from './report-sql';
import { loadWeeklyBundles, weekOfMonday, weeklyGate, type WeeklyBundle } from './weekly-bundle';
import { addDays } from '../../lib/kst';
import { lockScheduleSeries } from '../schedule/schedule.state.repo';
import type { FileRefDto } from '../files/files.dto';
import { storedFileRef } from '../files/files.service';

interface Row {
  id: string;
  ser_id: string;
  date: string;
  on_date: string;
  start_min: number | null;
  end_min: number | null;
  mode: 'offline' | 'online';
  end_min_utc: string | null;
  sub_key: string | null;
  kind_key: string;
  teacher_id: string | null;
  teacher_name: string | null;
  state: RepStateDb;
  reportable: boolean;
  canceled: boolean;
  ended: boolean;
  students: Array<{ id: number; name: string; grade: string | null; deliver: boolean; late: boolean }> | null;
}

interface DetailRow extends Row {
  body: unknown;
  subject_name: string;
  lang: string;
  written_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
}

interface SendHistoryRow {
  id: string;
  source_send_id: string | null;
  student_id: string;
  student_name: string;
  on_date: string;
  rep_ids: unknown;
  channel: string;
  sent_at: string;
  sent_by: string;
  sent_by_name: string;
  file_count: string;
  total_count: string;
  subject_names: string[] | null;
  teacher_names: string[] | null;
}

/**
 * 보낸 한 건의 **과목 · 강사** — `rs.rep_ids` 가 가리키는 리포트들에서 읽는다 (g5 48-03).
 * 원문 줄 「기록지 · 학생 · 과목 · 강사 · 08-19 수업」. 과목이 없는 종류(회의 등)는 종류 이름.
 * 강사는 그 회차의 강사, 없으면 리포트 작성 강사 — 목록(list)과 같은 COALESCE 순서.
 */
const SEND_LESSON_COLUMNS = `(SELECT COALESCE(array_agg(DISTINCT COALESCE(sb.name, k.name))
                    FILTER (WHERE COALESCE(sb.name, k.name) IS NOT NULL), '{}')
           FROM rep r JOIN ser s2 ON s2.id = r.ser_id
           LEFT JOIN sub sb ON sb.key = s2.sub_key LEFT JOIN kind k ON k.key = s2.kind_key
          WHERE r.id IN (SELECT (jsonb_array_elements_text(rs.rep_ids))::bigint)) AS subject_names,
        (SELECT COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}')
           FROM rep r LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
           LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
          WHERE r.id IN (SELECT (jsonb_array_elements_text(rs.rep_ids))::bigint)) AS teacher_names`;

/** 보낸 내역 묶음의 첫날(KST) — 주는 월요일(date_trunc week) · 달은 1일 (g5 48-02) */
const SEND_SPAN_START: Record<ReportSendSpan, string> = {
  day: kstDateOf('rs.sent_at'),
  week: `date_trunc('week', ${kstDateOf('rs.sent_at')})::date`,
  month: `date_trunc('month', ${kstDateOf('rs.sent_at')})::date`,
};

interface ReminderRow {
  id: string;
  to_id: string;
  from_id: string | null;
  request_teacher_id: string | null;
  teacher_name: string;
  category: string;
  count: string;
  created_at: string;
}

interface DeliveryFile {
  repId: number;
  fileName: string;
  plainText: string;
  bytes: Buffer;
}

interface Queryer {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

interface RequestSendRow {
  id: string;
  student_id: string;
  on_date: string;
  rep_ids: unknown;
  body: string;
  source_send_id: string | null;
}


const WRITE_ERRORS: Record<ReportWriteIssue, { message: string; status: 'bad' | 'forbidden' | 'conflict' }> = {
  REPORT_NOT_ALLOWED: { message: '리포트 대상 수업이 아닙니다', status: 'bad' },
  REPORT_CANCELED: { message: '취소된 회차에는 리포트를 쓸 수 없습니다', status: 'bad' },
  REPORT_NOT_ENDED: { message: '수업이 끝난 뒤에 리포트를 저장할 수 있습니다', status: 'bad' },
  REPORT_FORBIDDEN: { message: '담당 강사 또는 전체 관리 권한이 필요합니다', status: 'forbidden' },
  REPORT_LOCKED: { message: '제출 대기 또는 승인된 리포트는 고칠 수 없습니다', status: 'conflict' },
};

const REVIEW_ERRORS: Record<ReportReviewIssue, { message: string; status: 'bad' | 'forbidden' | 'conflict' }> = {
  REPORT_REVIEW_FORBIDDEN: { message: '리포트 승인 권한이 필요합니다', status: 'forbidden' },
  SELF_APPROVAL_FORBIDDEN: {
    message: '자기가 쓴 리포트는 자기가 승인할 수 없습니다 — 쓰는 사람과 결재하는 사람은 다릅니다',
    status: 'conflict',
  },
  REPORT_NOT_WAITING: { message: '승인 대기 중인 리포트만 검토할 수 있습니다', status: 'conflict' },
  APPROVE_REASON_FORBIDDEN: { message: '승인할 때는 반려 사유를 보낼 수 없습니다', status: 'bad' },
  REJECT_REASON_REQUIRED: { message: '반려 사유를 입력해야 합니다', status: 'bad' },
};

const DELIVERY_ERRORS: Record<ReportDeliveryIssue | ReportPngIssue, {
  message: string; status: 'bad' | 'forbidden' | 'conflict';
}> = {
  REPORT_DELIVERY_FORBIDDEN: { message: '리포트 발송은 매니저 이상만 할 수 있습니다', status: 'forbidden' },
  REPORT_DELIVERY_EMPTY: { message: '전달할 리포트가 없습니다', status: 'bad' },
  REPORT_DELIVERY_INCOMPLETE: { message: '안 쓴 리포트가 있어 이 학생에게 발송할 수 없습니다', status: 'conflict' },
  REPORT_DELIVERY_NOT_APPROVED: { message: '승인되지 않은 리포트가 있어 이 학생에게 발송할 수 없습니다', status: 'conflict' },
  REPORT_DELIVERY_FILES_MISMATCH: { message: '학생의 리포트와 PNG 파일 집합이 일치하지 않습니다', status: 'bad' },
  REPORT_DELIVERY_PNG_FORMAT: { message: '올바른 PNG 파일이 아닙니다', status: 'bad' },
  REPORT_DELIVERY_PNG_SIZE: { message: 'PNG 파일은 한 장당 3MB 이하여야 합니다', status: 'bad' },
};

const REMINDER_ERRORS: Record<ReportReminderIssue, { message: string; status: 'forbidden' | 'conflict' }> = {
  REPORT_REMINDER_FORBIDDEN: { message: '리포트 독촉은 매니저 이상만 할 수 있습니다', status: 'forbidden' },
  REPORT_REMINDER_STALE: { message: '선택한 강사에게 현재 독촉할 리포트가 없습니다', status: 'conflict' },
};

@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REPORT_FILE_STORE) private readonly files: ReportFileStore,
  ) {}

  private static sql(where: string, lock = false): string {
    return `SELECT r.id, r.ser_id,
                   to_char(${REPORT_DATE_SQL}, 'YYYY-MM-DD') AS date,
                   to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   ${START_MIN} AS start_min, ${END_MIN} AS end_min,
                   ${effectiveModeOf('x', 's')} AS mode,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   COALESCE(r.kind_key, s.kind_key) AS kind_key, s.sub_key,
                   COALESCE(o.teacher_id, r.teacher_id) AS teacher_id, t.name AS teacher_name, r.state,
                   k.rep AS reportable,
                   ${REPORT_CANCELED_SQL} AS canceled,
                   COALESCE(upper(o.span) <= now(), false) AS ended,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'id', st.id, 'name', st.name, 'grade', st.grade, 'deliver', rs.deliver,
                       'late', EXISTS (
                         SELECT 1 FROM att_late al
                          WHERE al.att_id=a.id AND al.student_id=st.id)
                     ) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              LEFT JOIN exc x ON x.ser_id = r.ser_id AND x.on_date = r.on_date
              LEFT JOIN att a ON a.ser_id = r.ser_id AND a.on_date = r.on_date
              LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
             WHERE ${where}
             ORDER BY date DESC, start_min DESC
             ${lock ? 'FOR UPDATE OF r' : ''}`;
  }

  private static detailSql(where: string, lock: boolean): string {
    return `SELECT r.id, r.ser_id,
                   to_char(${REPORT_DATE_SQL}, 'YYYY-MM-DD') AS date,
                   to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   ${START_MIN} AS start_min, ${END_MIN} AS end_min,
                   ${effectiveModeOf('x', 's')} AS mode,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   COALESCE(r.kind_key, s.kind_key) AS kind_key, s.sub_key,
                   COALESCE(o.teacher_id, r.teacher_id) AS teacher_id, t.name AS teacher_name, r.state,
                   r.body, r.lang, COALESCE(sb.name, s.title, k.name) AS subject_name,
                   k.rep AS reportable,
                   ${REPORT_CANCELED_SQL} AS canceled,
                   COALESCE(upper(o.span) <= now(), false) AS ended,
                   to_char(r.written_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS written_at,
                   to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
                   to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
                   r.reject_reason,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'id', st.id, 'name', st.name, 'grade', st.grade, 'deliver', rs.deliver,
                       'late', EXISTS (
                         SELECT 1 FROM att_late al
                          WHERE al.att_id=a.id AND al.student_id=st.id)
                     ) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              LEFT JOIN exc x ON x.ser_id = r.ser_id AND x.on_date = r.on_date
              LEFT JOIN att a ON a.ser_id = r.ser_id AND a.on_date = r.on_date
              JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
              LEFT JOIN sub sb ON sb.key = s.sub_key
              LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
             WHERE ${where}
             ORDER BY date, start_min, r.id
             ${lock ? 'FOR UPDATE OF r' : ''}`;
  }

  /** 판정은 rules.ts 한 곳에서만 — 화면도 이 결과를 읽기만 한다. */
  private toRow(r: Row, now: Date): ReportRowDto {
    const end = r.end_min_utc ? new Date(r.end_min_utc) : null;
    const minutesSinceEnd = end ? Math.floor((now.getTime() - end.getTime()) / 60000) : -1;
    const state = effectiveRepStateFromEnded(r.state, r.reportable && !r.canceled, r.ended);
    const written = isWrittenDbState(state);
    const penalty = written || minutesSinceEnd < 0 ? 0 : tierFor(minutesSinceEnd).amount;
    return {
      id: Number(r.id), serId: Number(r.ser_id), date: r.date, onDate: r.on_date, startMin: r.start_min,
      endMin: r.end_min, mode: r.mode,
      subKey: r.sub_key, kindKey: r.kind_key,
      teacherId: r.teacher_id ? Number(r.teacher_id) : null, teacherName: r.teacher_name,
      state, written, minutesSinceEnd, penalty,
      students: (r.students ?? []).map((s) => ({
        id: Number(s.id), name: s.name, grade: s.grade, deliver: Boolean(s.deliver), late: Boolean(s.late),
      })),
    };
  }

  /** 기존/외부 행이 있어도 화면에서는 정해진 세 키만 본다. DB 제약은 새 오염을 별도로 막는다. */
  private body(raw: unknown): ReportBody {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return {
      content: typeof value.content === 'string' ? value.content : '',
      progress: typeof value.progress === 'string' ? value.progress : '',
      homework: typeof value.homework === 'string' ? value.homework : '',
    };
  }

  private canEdit(r: DetailRow, actorId: number, canCrudAll: boolean): boolean {
    return reportWriteIssue({
      actorId,
      teacherId: r.teacher_id ? Number(r.teacher_id) : null,
      canCrudAll,
      reportable: r.reportable,
      canceled: r.canceled,
      ended: r.ended,
      state: r.state,
    }) === null;
  }

  private toDetail(r: DetailRow, actorId: number, canCrudAll: boolean, canApprove = canCrudAll): ReportDetailDto {
    const row = this.toRow(r, new Date());
    const body = this.body(r.body);
    const canExport = canExportReport({
      actorId,
      teacherId: r.teacher_id ? Number(r.teacher_id) : null,
      canCrudAll,
      state: r.state,
    });
    return {
      ...row,
      body,
      fields: REPORT_FIELDS.map((field) => ({ ...field })),
      canEdit: this.canEdit(r, actorId, canCrudAll),
      // 자기가 쓴 리포트에는 승인 단추가 서지 않는다 — 쓰기 경로와 같은 판정을 쓴다(D-R39)
      canReview: reportReviewIssue({
        canApprove, state: r.state, decision: 'approve', teacherId: r.teacher_id, actorId,
      }) === null,
      canExport,
      exportFiles: canExport ? row.students.map((student) => {
        const fileName = reportPngFileName({
          date: row.date,
          studentName: student.name,
          studentGrade: student.grade,
          subjectName: r.subject_name,
          startMin: row.startMin,
        });
        const plainText = reportPlainText({
          date: row.date,
          studentName: student.name,
          studentGrade: student.grade,
          subjectName: r.subject_name,
          startMin: row.startMin,
          endMin: row.endMin,
          body,
        });
        // 조회·상세·발송 검증이 같은 출력 버전을 공유한다. 클라이언트는 재계산하지 않는다.
        const revision = createHash('sha256').update(JSON.stringify([fileName, plainText])).digest('hex');
        return { studentId: student.id, fileName, plainText, revision };
      }) : [],
      canDeliver: canCrudAll,
      subjectName: r.subject_name,
      lang: r.lang,
      writtenAt: r.written_at,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      rejectReason: r.reject_reason,
    };
  }

  private async loadDetail(q: Queryer, serId: number, onDate: string, lock = false): Promise<DetailRow | null> {
    const rows = await q.query<DetailRow[]>(
      ReportsService.detailSql('r.ser_id = $1 AND r.on_date = $2', lock), [serId, onDate],
    );
    return rows[0] ?? null;
  }

  private static kstYesterday(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private async deliveryRows(q: Queryer, onDate: string, studentId?: number, lock = false): Promise<DetailRow[]> {
    const where = `${REPORT_DATE_SQL} = $1 AND NOT ${REPORT_CANCELED_SQL}
      AND EXISTS (SELECT 1 FROM rep_stu x WHERE x.rep_id = r.id AND x.deliver
        ${studentId === undefined ? '' : 'AND x.student_id = $2'})`;
    return q.query<DetailRow[]>(ReportsService.detailSql(where, lock),
      studentId === undefined ? [onDate] : [onDate, studentId]);
  }

  private deliveryFiles(rows: DetailRow[], dto: ReportDeliveryCreateDto, actorId: number): DeliveryFile[] {
    const expectedRepIds = rows.map((row) => Number(row.id));
    const issue = reportDeliveryIssue({
      canCrudAll: true,
      states: rows.map((row) => row.state),
      expectedRepIds,
      actualRepIds: dto.files.map((file) => file.repId),
    });
    if (issue) this.throwDeliveryIssue(issue);

    const inputByRepId = new Map(dto.files.map((file) => [file.repId, file]));
    return rows.map((row) => {
      const repId = Number(row.id);
      const input = inputByRepId.get(repId)!;
      const expected = this.toDetail(row, actorId, true).exportFiles
        .find((file) => file.studentId === dto.studentId);
      if (!expected || expected.fileName !== input.fileName || expected.revision !== input.revision) {
        this.throwDeliveryIssue('REPORT_DELIVERY_FILES_MISMATCH');
      }
      const decoded = decodeReportPng(input.pngDataUrl);
      if (decoded.issue) this.throwDeliveryIssue(decoded.issue);
      return { repId, fileName: expected.fileName, plainText: expected.plainText, bytes: decoded.bytes };
    });
  }

  /**
   * 발송 이력 한 줄.
   *
   * **`fileCount` 는 재발송이 실제로 세는 것과 같은 것을 센다**(S5) — `pdflog` 의 `report_png` 중
   * **`file_url` 이 있는** 행이다. 전에는 화면의 「파일 N장 보관」이 `file_url` 없는 행까지 세어
   * **N > 0 인데 재발송은 409** 가 났다. 두 수의 출처가 다르면 화면이 조용히 거짓을 말한다.
   *
   * 단추가 서는지도 그 수에서 나온다(D-R39) — 화면이 `fileCount` 를 다시 해석하지 않는다.
   */
  private static historyRow(row: SendHistoryRow, downloadFiles: FileRefDto[] = []): ReportSendHistoryDto {
    const repIds = Array.isArray(row.rep_ids)
      ? row.rep_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const fileCount = Number(row.file_count);
    return {
      id: Number(row.id), sourceSendId: row.source_send_id ? Number(row.source_send_id) : null,
      studentId: Number(row.student_id), studentName: row.student_name,
      onDate: row.on_date, repIds, channel: row.channel, fileCount,
      downloadFiles,
      canResend: fileCount > 0,
      resendBlockedReason: fileCount > 0 ? null : '재발송할 보존 파일이 없습니다',
      sentAt: row.sent_at, sentBy: Number(row.sent_by), sentByName: row.sent_by_name,
      subjectNames: row.subject_names ?? [], teacherNames: row.teacher_names ?? [],
    };
  }

  /**
   * 발송에 붙은 현재 FILE 참조만 돌려준다. 예전 외부 Blob/seed URL은 FILE id로 추정하지 않고
   * 빈 배열에 남긴다. 실제 바이트 열람은 `/files/:id` 중앙 ACL이 다시 판정한다.
   */
  private static async downloadFilesBySend(q: Queryer, sendIds: number[]): Promise<Map<number, FileRefDto[]>> {
    const grouped = new Map<number, FileRefDto[]>();
    if (sendIds.length === 0) return grouped;
    const rows = await q.query<Array<Record<string, unknown>>>(
      `SELECT p.ref_id AS send_id, f.id AS file_id, f.kind AS file_kind, f.name AS file_name,
              f.mime AS file_mime, f.bytes AS file_bytes, u.name AS file_uploader_name,
              to_char(f.uploaded_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS file_uploaded_at
         FROM pdflog p
         JOIN file f ON p.file_url = '/files/' || f.id::text AND f.kind = 'report-png'
         LEFT JOIN staff u ON u.id = f.uploaded_by
        WHERE p.kind='report_png' AND p.ref_id = ANY($1::bigint[])
        ORDER BY p.id`,
      [sendIds],
    );
    for (const row of rows) {
      const ref = storedFileRef(row);
      if (!ref) continue;
      const sendId = Number(row.send_id);
      if (!grouped.has(sendId)) grouped.set(sendId, []);
      grouped.get(sendId)!.push(ref);
    }
    return grouped;
  }

  /** 묶음 이름 — 일 「MM-DD」 · 주 「MM-DD ~ MM-DD」(원문 §48) · 달 「YYYY년 M월」. 낱말은 여기 한 곳 */
  private static sendGroupLabel(span: ReportSendSpan, from: string, to: string): string {
    if (span === 'month') return `${from.slice(0, 4)}년 ${Number(from.slice(5, 7))}월`;
    if (span === 'week') return `${from.slice(5)} ~ ${to.slice(5)}`;
    return from.slice(5);
  }

  private async historyItem(q: Queryer, sendId: number): Promise<ReportSendHistoryDto | null> {
    const rows = await q.query<SendHistoryRow[]>(
      `SELECT rs.id, rs.source_send_id, rs.student_id, st.name AS student_name,
              to_char(rs.on_date, 'YYYY-MM-DD') AS on_date,
              rs.rep_ids, rs.channel,
              to_char(rs.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
              rs.sent_by, sf.name AS sent_by_name,
              (SELECT count(*) FROM pdflog p WHERE p.kind='report_png' AND p.ref_id=rs.id AND p.file_url IS NOT NULL)::text AS file_count,
              ${SEND_LESSON_COLUMNS}
         FROM rsend rs JOIN stu st ON st.id=rs.student_id JOIN staff sf ON sf.id=rs.sent_by
        WHERE rs.id=$1`,
      [sendId],
    );
    if (!rows[0]) return null;
    const files = await ReportsService.downloadFilesBySend(q, [sendId]);
    return ReportsService.historyRow(rows[0], files.get(sendId) ?? []);
  }

  private async requireHistoryItem(q: Queryer, sendId: number): Promise<ReportSendHistoryDto> {
    const item = await this.historyItem(q, sendId);
    if (!item) {
      throw new NotFoundException({ code: 'REPORT_DELIVERY_NOT_FOUND', message: '발송 이력을 찾을 수 없습니다' });
    }
    return item;
  }

  private throwWriteIssue(issue: ReportWriteIssue): never {
    const error = WRITE_ERRORS[issue];
    const body = { code: issue, message: error.message };
    if (error.status === 'forbidden') throw new ForbiddenException(body);
    if (error.status === 'conflict') throw new ConflictException(body);
    throw new BadRequestException(body);
  }

  private throwReviewIssue(issue: ReportReviewIssue): never {
    const error = REVIEW_ERRORS[issue];
    const body = { code: issue, message: error.message };
    if (error.status === 'forbidden') throw new ForbiddenException(body);
    if (error.status === 'conflict') throw new ConflictException(body);
    throw new BadRequestException(body);
  }

  private throwDeliveryIssue(issue: ReportDeliveryIssue | ReportPngIssue): never {
    const error = DELIVERY_ERRORS[issue];
    const body = { code: issue, message: error.message };
    if (error.status === 'forbidden') throw new ForbiddenException(body);
    if (error.status === 'conflict') throw new ConflictException(body);
    throw new BadRequestException(body);
  }

  private throwReminderIssue(issue: ReportReminderIssue): never {
    const error = REMINDER_ERRORS[issue];
    const body = { code: issue, message: error.message };
    if (error.status === 'forbidden') throw new ForbiddenException(body);
    throw new ConflictException(body);
  }

  private reminderRequestKeyConflict(): never {
    throw new ConflictException({
      code: 'REPORT_REMINDER_REQUEST_KEY_REUSED',
      message: '같은 요청 키를 다른 독촉 대상에 사용할 수 없습니다',
    });
  }

  private requireDeliveryPermission(canCrudAll: boolean): void {
    const issue = reportDeliveryIssue({
      canCrudAll, states: [], expectedRepIds: [], actualRepIds: [],
    });
    if (issue === 'REPORT_DELIVERY_FORBIDDEN') this.throwDeliveryIssue(issue);
  }

  async list(opts: Readonly<ReportQueryDto>): Promise<ReportRowDto[]> {
    const p: unknown[] = [];
    const c: string[] = ['1=1'];
    if (opts.from) { p.push(opts.from); c.push(`${REPORT_DATE_SQL} >= $${p.length}`); }
    if (opts.to) { p.push(opts.to); c.push(`${REPORT_DATE_SQL} <= $${p.length}`); }
    if (opts.teacherId) { p.push(opts.teacherId); c.push(`COALESCE(o.teacher_id, r.teacher_id) = $${p.length}`); }
    const rows = await this.ds.query<Row[]>(ReportsService.sql(c.join(' AND ')), p);
    const now = new Date();
    const items = rows.map((r) => this.toRow(r, now));
    return opts.state ? items.filter((item) => item.state === opts.state) : items;
  }

  /**
   * §47 스캔 후보를 실제 종료·취소 상태와 겹쳐 읽는다.
   * lock은 부모 SER를 먼저 잠겄 후에만 사용해 일정 쓰기와 순서를 맞춘다.
   */
  private async actionRows(
    q: Queryer, teacherId?: number, lock = false, serIds?: number[],
  ): Promise<Row[]> {
    const p: unknown[] = [REPORT_ACTION_REQUIRED_CANDIDATE_DB];
    const c = [
      `r.state = ANY($${p.length}::rep_state_t[])`,
      `k.rep`,
      `NOT COALESCE(o.canceled, false)`,
      `COALESCE(a.result, 'completed') <> 'canceled'`,
      `upper(o.span) < now()`,
    ];
    if (teacherId) { p.push(teacherId); c.push(`COALESCE(o.teacher_id, r.teacher_id) = $${p.length}`); }
    // 부모 SER를 잠근 뒤 재검증할 때는 그 잠금 집합만 읽어, 잠그지 않은 신규 일정까지 섞지 않는다.
    if (serIds) { p.push(serIds); c.push(`r.ser_id = ANY($${p.length}::bigint[])`); }
    return q.query<Row[]>(ReportsService.sql(c.join(' AND '), lock), p);
  }

  private actionItems(rows: Row[]): ReportRowDto[] {
    const now = new Date();
    return rows.map((row) => this.toRow(row, now)).filter((item) => needsReportActionDbState(item.state));
  }

  /** §47 안 쓴 리포트 — 강사별로 몇 건 밀렸는지. */
  async unwritten(teacherId?: number): Promise<UnwrittenDto> {
    const items = this.actionItems(await this.actionRows(this.ds, teacherId));

    const g = new Map<number, { name: string; items: ReportRowDto[] }>();
    for (const it of items) {
      if (!it.teacherId) continue;
      const cur = g.get(it.teacherId) ?? { name: it.teacherName ?? '-', items: [] };
      cur.items.push(it);
      g.set(it.teacherId, cur);
    }
    const [t1, t4] = [LATE_REPORT_TIERS[1].fromMinutes, LATE_REPORT_TIERS[0].fromMinutes];
    // 오른쪽 머리 「이름 · 역할 · 직함」 — 역할 낱말은 서버 한 벌(lib/role-words) (g5 47-07)
    const staffRows = g.size === 0 ? [] : await this.ds.query<Array<{ id: string; role: string; title: string | null }>>(
      `SELECT id, role, title FROM staff WHERE id = ANY($1::bigint[])`, [[...g.keys()]],
    );
    const staffOf = new Map(staffRows.map((row) => [Number(row.id), row]));
    const byTeacher = [...g.entries()]
      .map(([teacherId2, v]) => ({
        teacherId: teacherId2,
        teacherName: v.name,
        roleLabel: roleLabel(staffOf.get(teacherId2)?.role ?? 'teacher'),
        title: staffOf.get(teacherId2)?.title ?? null,
        count: v.items.length,
        oldestDate: v.items.map((x) => x.date).sort()[0] ?? null,
        over1h: v.items.filter((x) => x.minutesSinceEnd >= t1).length,
        over4h: v.items.filter((x) => x.minutesSinceEnd >= t4).length,
        penalty: v.items.reduce((a, x) => a + x.penalty, 0),
      }))
      .sort((a, b) => b.count - a.count || a.teacherName.localeCompare(b.teacherName));

    return {
      byTeacher,
      total: items.length,
      penaltyTotal: items.reduce((a, x) => a + x.penalty, 0),
      items,
    };
  }

  private async reminderRows(q: Queryer, requestKey: string): Promise<ReminderRow[]> {
    return q.query<ReminderRow[]>(
      `SELECT n.id, n.to_id, n.from_id, n.request_teacher_id,
              s.name AS teacher_name, n.category,
              COALESCE(l.count, '0') AS count,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM noti n
         JOIN staff s ON s.id=n.to_id
         LEFT JOIN LATERAL (
           SELECT after->>'count' AS count
             FROM log
            WHERE entity='NOTI' AND entity_id=n.id AND action='remind'
            ORDER BY id DESC LIMIT 1
         ) l ON true
        WHERE n.request_key=$1
        ORDER BY n.to_id`,
      [requestKey],
    );
  }

  private reminderResult(requestKey: string, rows: ReminderRow[]): ReportReminderResultDto {
    return {
      requestKey,
      items: rows.map((row) => ({
        teacherId: Number(row.to_id), teacherName: row.teacher_name,
        count: Number(row.count), createdAt: row.created_at,
      })),
    };
  }

  /** §47 독촉은 외부 발송이 아니라 수신 강사의 NOTI 원장을 만든다. */
  async reminders(
    dto: ReportReminderCreateDto, actorId: number, canCrudAll: boolean,
  ): Promise<ReportReminderResultDto> {
    const permissionIssue = reportReminderIssue(canCrudAll, false, 0);
    if (permissionIssue) this.throwReminderIssue(permissionIssue);

    const q = this.ds.createQueryRunner();
    try {
      // 연결/BEGIN 실패도 finally의 runner 해제 경계를 반드시 지난다.
      await q.connect();
      await q.startTransaction();
      // UNIQUE와 별개로 같은 requestKey 배치 전체를 직렬화해 서로 다른 수신자로 갈라지지 않게 한다.
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [dto.requestKey]);
      const prior = await this.reminderRows(q, dto.requestKey);
      if (prior.length) {
        const sameActor = prior.every((row) => Number(row.from_id) === actorId && row.category === 'report_due');
        const requestedTeacherId = dto.teacherId ?? null;
        const sameRequestScope = prior.every((row) => row.request_teacher_id === null
          ? requestedTeacherId === null
          : Number(row.request_teacher_id) === requestedTeacherId);
        if (!sameActor || !sameRequestScope) this.reminderRequestKeyConflict();
        await q.commitTransaction();
        return this.reminderResult(dto.requestKey, prior);
      }

      const initial = this.actionItems(await this.actionRows(q, dto.teacherId));
      const serIds = [...new Set(initial.map((item) => item.serId))];
      await lockScheduleSeries(q, serIds);
      const fresh = serIds.length
        ? this.actionItems(await this.actionRows(q, dto.teacherId, true, serIds))
        : [];
      const staleIssue = reportReminderIssue(canCrudAll, dto.teacherId !== undefined, fresh.length);
      if (staleIssue) this.throwReminderIssue(staleIssue);

      // 전체 0명은 저장할 수신 원장이 없으므로 빈 성공이며, 같은 키 재시도도 최신 집합을 다시 센다.
      const grouped = new Map<number, { teacherName: string; count: number }>();
      for (const item of fresh) {
        if (!item.teacherId) continue;
        const current = grouped.get(item.teacherId) ?? { teacherName: item.teacherName ?? '-', count: 0 };
        current.count += 1;
        grouped.set(item.teacherId, current);
      }

      for (const [teacherId, summary] of [...grouped.entries()].sort(([a], [b]) => a - b)) {
        const inserted = await q.query(
          `INSERT INTO noti (
             to_id, from_id, body, link, category, request_key, request_teacher_id, title
           ) VALUES ($1, $2, $3, '/reports?section=unwritten', 'report_due', $4, $5, $6)
           ON CONFLICT (request_key, to_id) WHERE request_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            teacherId, actorId, `안 쓴 리포트 ${summary.count}건을 확인해 주세요.`,
            dto.requestKey, dto.teacherId ?? null, NOTI_TITLE.reportDue,
          ],
        ) as Array<{ id: string }>;
        if (!inserted[0]) continue;
        await q.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, after)
           VALUES ($1, 'NOTI', $2, 'remind', $3::jsonb)`,
          [actorId, Number(inserted[0].id), JSON.stringify({
            requestKey: dto.requestKey, teacherId, count: summary.count,
          })],
        );
      }

      const saved = await this.reminderRows(q, dto.requestKey);
      if (saved.length !== grouped.size) this.reminderRequestKeyConflict();
      await q.commitTransaction();
      return this.reminderResult(dto.requestKey, saved);
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }

  /* ══ N-54 주간 묶음 (W11 · R2) ═══════════════════════════════════════════
   * 판정 · 모으기는 weekly-bundle.ts 한 곳이다 — 보호자 발송(guardians.service)도 같은 함수를 부른다(D-R22 · D-R39).
   */

  private static weekLabel(weekOf: string): string {
    return ReportsService.sendGroupLabel('week', weekOf, addDays(weekOf, 6));
  }

  private static toWeekly(bundle: WeeklyBundle, canWrite: boolean, label: string): WeeklyBundleDto {
    const gate = weeklyGate(bundle, canWrite);
    return {
      studentId: bundle.studentId, studentName: bundle.studentName, grade: bundle.grade,
      wrepId: bundle.wrepId, summary: bundle.summary, legacy: bundle.legacy,
      lessons: bundle.lessons.map((lesson) => ({ ...lesson })),
      lessonCount: bundle.lessons.length,
      approvedCount: bundle.lessons.filter((lesson) => lesson.approved).length,
      ...gate,
      // 메일 제목 기본값 — 사실(학생 · 주)만 잇는다. 창에서 고칠 수 있고 본문과 달리 검증하지 않는다
      subject: `${bundle.studentName} 학생 주간 리포트 · ${label}`,
      sentAt: bundle.sentAt, attemptCount: bundle.attemptCount, lastAttemptAt: bundle.lastAttemptAt,
    };
  }

  /** §47 「주간 트래킹」 — 그 주 학생별 묶음. 주를 안 주면 KST 어제가 든 주(월요일이면 막 끝난 지난주) */
  async weekly(weekOfAny: string | undefined, canWrite: boolean): Promise<WeeklyBundleListDto> {
    const weekOf = weekOfMonday(weekOfAny ?? ReportsService.kstYesterday());
    const label = ReportsService.weekLabel(weekOf);
    const bundles = (await loadWeeklyBundles(this.ds, weekOf, null))
      .map((bundle) => ReportsService.toWeekly(bundle, canWrite, label));
    return {
      weekOf, weekTo: addDays(weekOf, 6), label,
      total: bundles.length,
      remaining: bundles.filter((bundle) => bundle.sentAt === null).length,
      bundles,
    };
  }

  /**
   * 총평 쓰기 — `wrep.body = {summary, by, at}` 만(N-54 ②). 그 주 리포트가 없는 학생 · 이미 보낸 묶음 · 옛 기록은 막는다.
   * 학생 줄을 먼저 잡아 같은 학생 · 같은 주의 첫 쓰기 둘이 줄을 서고, 있던 묶음은 행을 잠근다(보내기와 같은 순서).
   */
  async writeWeeklySummary(dto: WeeklySummaryWriteDto, actorId: number, canWrite: boolean): Promise<WeeklyBundleDto> {
    const summary = dto.summary.trim();
    if (!summary) throw new BadRequestException({ code: 'WEEKLY_SUMMARY_REQUIRED', message: '총평을 써 주세요' });
    const weekOf = weekOfMonday(dto.weekOf);
    const label = ReportsService.weekLabel(weekOf);
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const [student] = await q.query(`SELECT id FROM stu WHERE id = $1 FOR NO KEY UPDATE`, [dto.studentId]) as Array<{ id: string }>;
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const [bundle] = await loadWeeklyBundles(q, weekOf, dto.studentId, true);
      if (!bundle) throw new ConflictException({ code: 'WEEKLY_NO_LESSONS', message: '이 주에 이 학생의 리포트가 없습니다' });
      const gate = weeklyGate(bundle, canWrite);
      if (!gate.canWriteSummary) {
        if (!canWrite) throw new ForbiddenException({ code: 'WEEKLY_FORBIDDEN', message: gate.summaryBlockedReason });
        throw new ConflictException({
          code: bundle.legacy ? 'WEEKLY_LEGACY' : 'WEEKLY_ALREADY_SENT', message: gate.summaryBlockedReason,
        });
      }
      await q.query(
        `INSERT INTO wrep (student_id, week_of, body)
         VALUES ($1, $2, jsonb_build_object('summary', $3::text, 'by', $4::bigint, 'at', ${kstAt('now()')}))
         ON CONFLICT (student_id, week_of) DO UPDATE SET body = EXCLUDED.body`,
        [dto.studentId, weekOf, summary, actorId],
      );
      const [saved] = await loadWeeklyBundles(q, weekOf, dto.studentId);
      await q.commitTransaction();
      return ReportsService.toWeekly(saved, canWrite, label);
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }

  async detail(
    serId: number, onDate: string, actorId: number, canCrudAll: boolean, canApprove = canCrudAll,
  ): Promise<ReportDetailDto> {
    const row = await this.loadDetail(this.ds, serId, onDate);
    if (!row) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });
    const submittedForReview = row.state === 'wait' || row.state === 'ok' || row.state === 'rej';
    if (actorId !== Number(row.teacher_id) && !canCrudAll && !(canApprove && submittedForReview)) {
      this.throwWriteIssue('REPORT_FORBIDDEN');
    }
    return this.toDetail(row, actorId, canCrudAll, canApprove);
  }

  /** §48·§49 — KST 하루의 전달 대상과 D-R8 차단 사유를 학생 단위로 묶는다. */
  async deliveryQueue(onDate: string | undefined, actorId: number, canCrudAll: boolean): Promise<ReportDeliveryQueueDto> {
    this.requireDeliveryPermission(canCrudAll);
    const date = onDate ?? ReportsService.kstYesterday();
    const [rows, latest] = await Promise.all([
      this.deliveryRows(this.ds, date),
      this.ds.query<Array<{ student_id: string; id: string; sent_at: string }>>(
        `SELECT DISTINCT ON (student_id) student_id, id,
                to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at
           FROM rsend WHERE on_date=$1
          ORDER BY student_id, sent_at DESC, id DESC`,
        [date],
      ),
    ]);
    const lastByStudent = new Map(latest.map((item) => [Number(item.student_id), item]));
    const grouped = new Map<number, {
      student: ReportDetailDto['students'][number];
      entries: Array<{ detail: ReportDetailDto; state: RepStateDb }>;
    }>();
    for (const row of rows) {
      const detail = this.toDetail(row, actorId, true);
      for (const student of detail.students) {
        if (!student.deliver) continue;
        const group = grouped.get(student.id) ?? { student, entries: [] };
        group.entries.push({ detail, state: row.state });
        grouped.set(student.id, group);
      }
    }
    const students = [...grouped.values()].map(({ student, entries }) => {
      const blockedCount = entries.filter((entry) => entry.state !== 'ok').length;
      const last = lastByStudent.get(student.id);
      return {
        student,
        reports: entries.map((entry) => entry.detail),
        canSend: blockedCount === 0 && !last,
        blockedCount,
        lastSendId: last ? Number(last.id) : null,
        lastSentAt: last?.sent_at ?? null,
      };
    });
    return {
      onDate: date,
      total: students.length,
      remaining: students.filter((student) => student.canSend).length,
      blocked: students.filter((student) => student.blockedCount > 0).length,
      students,
    };
  }

  async deliveryHistory(
    opts: { onDate?: string; repId?: number; span?: ReportSendSpan }, canCrudAll: boolean,
  ): Promise<ReportSendHistoryListDto> {
    this.requireDeliveryPermission(canCrudAll);
    const p: unknown[] = [];
    const where: string[] = ['1=1'];
    if (opts.onDate) { p.push(opts.onDate); where.push(`rs.on_date=$${p.length}`); }
    if (opts.repId) { p.push(JSON.stringify([opts.repId])); where.push(`rs.rep_ids @> $${p.length}::jsonb`); }
    const rows = await this.ds.query<SendHistoryRow[]>(
      `SELECT rs.id, rs.source_send_id, rs.student_id, st.name AS student_name,
              to_char(rs.on_date, 'YYYY-MM-DD') AS on_date,
              rs.rep_ids, rs.channel,
              count(*) OVER()::text AS total_count,
              to_char(rs.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
              rs.sent_by, sf.name AS sent_by_name,
              (SELECT count(*) FROM pdflog x WHERE x.kind='report_png' AND x.ref_id=rs.id AND x.file_url IS NOT NULL)::text AS file_count,
              ${SEND_LESSON_COLUMNS}
         FROM rsend rs JOIN stu st ON st.id=rs.student_id JOIN staff sf ON sf.id=rs.sent_by
        WHERE ${where.join(' AND ')}
        ORDER BY rs.sent_at DESC, rs.id DESC LIMIT 100`,
      p,
    );
    /*
     * §48 묶음 — 건수 · 기록지 · 인원을 **100건 상한 밖까지** 센다. 화면이 items 로 다시 세면
     * 잘린 묶음의 수가 틀린다 (D-R37). 눈금이 없으면 묶음은 비우고 머리 「기록지 N장」만 센다.
     */
    const span = opts.span ?? null;
    const groupRows = await this.ds.query<Array<{
      from: string; to: string; count: string; sheets: string; students: string; send_ids: string[];
    }>>(
      `WITH base AS (
         SELECT rs.id, rs.student_id, rs.sent_at,
                ${SEND_SPAN_START[span ?? 'day']} AS start,
                (SELECT count(*) FROM pdflog x WHERE x.kind='report_png' AND x.ref_id=rs.id AND x.file_url IS NOT NULL) AS files
           FROM rsend rs
          WHERE ${where.join(' AND ')}
       )
       SELECT to_char(start,'YYYY-MM-DD') AS "from",
              to_char(CASE $${p.length + 1}::text
                        WHEN 'week' THEN start + 6
                        WHEN 'month' THEN (start + interval '1 month' - interval '1 day')::date
                        ELSE start END,'YYYY-MM-DD') AS "to",
              count(*)::text AS count, COALESCE(sum(files),0)::text AS sheets,
              count(DISTINCT student_id)::text AS students,
              array_agg(id::text ORDER BY sent_at DESC, id DESC) AS send_ids
         FROM base GROUP BY start ORDER BY start DESC`,
      [...p, span ?? 'day'],
    );
    const groups: ReportSendGroupDto[] = span === null ? [] : groupRows.map((row) => ({
      from: row.from, to: row.to, label: ReportsService.sendGroupLabel(span, row.from, row.to),
      count: Number(row.count), sheets: Number(row.sheets), students: Number(row.students),
      sendIds: row.send_ids.map(Number),
    }));
    const downloads = await ReportsService.downloadFilesBySend(this.ds, rows.map((row) => Number(row.id)));
    return {
      total: rows[0] ? Number(rows[0].total_count) : 0,
      items: rows.map((row) => ReportsService.historyRow(row, downloads.get(Number(row.id)) ?? [])),
      span,
      groups,
      sheets: groupRows.reduce((sum, row) => sum + Number(row.sheets), 0),
    };
  }

  private async sendForRequest(q: Queryer, requestKey: string): Promise<RequestSendRow | null> {
    const rows = await q.query<RequestSendRow[]>(
      `SELECT id, student_id, to_char(on_date, 'YYYY-MM-DD') AS on_date, rep_ids, body, source_send_id
         FROM rsend WHERE request_key=$1`,
      [requestKey],
    );
    return rows[0] ?? null;
  }

  private requestKeyConflict(): never {
    throw new ConflictException({
      code: 'REPORT_DELIVERY_REQUEST_KEY_REUSED',
      message: '같은 요청 키를 다른 발송 내용에 사용할 수 없습니다',
    });
  }

  private assertDeliveryIdentity(
    prior: RequestSendRow, studentId: number, onDate: string, repIds: number[],
  ): void {
    const savedRepIds = Array.isArray(prior.rep_ids) ? prior.rep_ids.map(Number) : [];
    const sameRepIds = savedRepIds.length === repIds.length
      && savedRepIds.every((id, index) => id === repIds[index]);
    if (
      Number(prior.student_id) !== studentId || prior.on_date !== onDate
      || prior.source_send_id !== null || !sameRepIds
    ) this.requestKeyConflict();
  }

  private async idempotentDelivery(
    q: Queryer, requestKey: string, studentId: number, onDate: string, files: DeliveryFile[],
  ): Promise<ReportSendHistoryDto | null> {
    const prior = await this.sendForRequest(q, requestKey);
    if (!prior) return null;
    const askedRepIds = files.map((file) => file.repId);
    this.assertDeliveryIdentity(prior, studentId, onDate, askedRepIds);
    if (prior.body !== ReportsService.deliveryBody(files)) this.requestKeyConflict();
    return this.requireHistoryItem(q, Number(prior.id));
  }

  private static deliveryBody(files: DeliveryFile[]): string {
    return files.map((file) => file.plainText).join('\n\n────────\n\n');
  }

  private async idempotentResend(
    q: Queryer, requestKey: string, sourceSendId: number,
  ): Promise<ReportSendHistoryDto | null> {
    const prior = await this.sendForRequest(q, requestKey);
    if (!prior) return null;
    if (Number(prior.source_send_id) !== sourceSendId) this.requestKeyConflict();
    return this.requireHistoryItem(q, Number(prior.id));
  }

  /** PNG 보존과 RSEND/PDFLOG 기록. 실제 카카오·알림톡 전송은 명세서의 미구현 외부 경계다. */
  async deliver(dto: ReportDeliveryCreateDto, actorId: number, canCrudAll: boolean): Promise<ReportSendHistoryDto> {
    this.requireDeliveryPermission(canCrudAll);
    const claimed = await this.sendForRequest(this.ds, dto.requestKey);
    if (claimed) {
      this.assertDeliveryIdentity(claimed, dto.studentId, dto.onDate, dto.files.map((file) => file.repId));
    }
    // 파일명·revision·PNG 형식까지 먼저 검증한다. 같은 requestKey라도 다른 출력 요청을
    // 과거 201로 조용히 수렴시키지 않는다.
    const rows = await this.deliveryRows(this.ds, dto.onDate, dto.studentId);
    const prepared = this.deliveryFiles(rows, dto, actorId);
    const prior = await this.idempotentDelivery(
      this.ds, dto.requestKey, dto.studentId, dto.onDate, prepared,
    );
    if (prior) return prior;
    const existing = await this.ds.query<Array<{ id: string }>>(
      `SELECT id FROM rsend WHERE student_id=$1 AND on_date=$2 AND source_send_id IS NULL LIMIT 1`,
      [dto.studentId, dto.onDate],
    );
    if (existing[0]) {
      // 최초 requestKey 조회 직후 같은 요청의 선행 트랜잭션이 커밋될 수 있다.
      // 날짜 중복으로 거절하기 전에 요청 내용을 다시 대조해 네트워크 재시도를 같은 결과로 수렴시킨다.
      const completed = await this.idempotentDelivery(
        this.ds, dto.requestKey, dto.studentId, dto.onDate, prepared,
      );
      if (completed) return completed;
      throw new ConflictException({ code: 'REPORT_DELIVERY_ALREADY_SENT', message: '이미 발송했습니다. 이력에서 다시 보내세요' });
    }

    const urls: string[] = [];
    try {
      for (const file of prepared) {
        urls.push(await this.files.put(`reports/${dto.onDate}/${dto.studentId}/${file.fileName}`, file.bytes));
      }
    } catch (error) {
      await this.files.delete(urls).catch(() => undefined);
      throw error;
    }

    const q = this.ds.createQueryRunner();
    let committed = false;
    let sendId = 0;
    try {
      // 업로드 뒤 연결/BEGIN 실패도 아래의 Blob 보상·runner 해제 경로를 반드시 거친다.
      await q.connect();
      await q.startTransaction();
      // 일정/출결/리포트 쓰기와 같은 SER→REP 순서. 잠금 뒤 별도 SELECT로 현재 투영을 읽는다.
      await lockScheduleSeries(q, [...new Set(rows.map((row) => Number(row.ser_id)))]);
      const idempotent = await this.idempotentDelivery(
        q, dto.requestKey, dto.studentId, dto.onDate, prepared,
      );
      if (idempotent) {
        await q.rollbackTransaction();
        await this.files.delete(urls).catch(() => undefined);
        return idempotent;
      }
      const lockedRows = await this.deliveryRows(q, dto.onDate, dto.studentId, true);
      const locked = this.deliveryFiles(lockedRows, dto, actorId);
      // 종료 시각/본문은 파일명에 모두 포함되지 않는다. 업로드 전후 출력 원문도 같아야 한다.
      if (locked.some((file, index) => file.repId !== prepared[index]?.repId
        || file.fileName !== prepared[index]?.fileName || file.plainText !== prepared[index]?.plainText)) {
        this.throwDeliveryIssue('REPORT_DELIVERY_FILES_MISMATCH');
      }
      const sent = await q.query(
        `INSERT INTO rsend (student_id, on_date, rep_ids, channel, body, sent_by, request_key, source_send_id)
         VALUES ($1,$2,$3::jsonb,'blob',$4,$5,$6,NULL) RETURNING id`,
        [
          dto.studentId, dto.onDate, JSON.stringify(locked.map((file) => file.repId)),
          ReportsService.deliveryBody(locked), actorId, dto.requestKey,
        ],
      ) as Array<{ id: string }>;
      sendId = Number(sent[0].id);
      // 7-3 ① F3 — 파일마다 어느 리포트인지 적는다(업로드 차례 = prepared 차례 = locked 차례 · 위에서 대조했다).
      await q.query(
        `INSERT INTO pdflog (kind, ref_id, file_url, rep_id)
         SELECT 'report_png', $1, f.url, f.rep_id FROM unnest($2::text[], $3::bigint[]) AS f(url, rep_id)`,
        [sendId, urls, prepared.map((file) => file.repId)],
      );
      await q.commitTransaction();
      committed = true;
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      if (!committed) await this.files.delete(urls).catch(() => undefined);
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505') {
        const raced = await this.idempotentDelivery(
          this.ds, dto.requestKey, dto.studentId, dto.onDate, prepared,
        );
        if (raced) return raced;
        if (e.constraint === 'rsend_student_date_first_uniq') {
          throw new ConflictException({ code: 'REPORT_DELIVERY_ALREADY_SENT', message: '이미 발송했습니다. 이력에서 다시 보내세요' });
        }
      }
      throw error;
    } finally {
      await q.release();
    }
    return this.requireHistoryItem(this.ds, sendId);
  }

  /** 이전 본문·private Blob URL을 그대로 가리키는 새 감사행을 만든다. */
  async resend(sendId: number, requestKey: string, actorId: number, canCrudAll: boolean): Promise<ReportSendHistoryDto> {
    this.requireDeliveryPermission(canCrudAll);
    const prior = await this.idempotentResend(this.ds, requestKey, sendId);
    if (prior) return prior;

    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    let newId = 0;
    try {
      const sources = await q.query(
        `SELECT id, student_id, to_char(on_date, 'YYYY-MM-DD') AS on_date, rep_ids, body
           FROM rsend WHERE id=$1 FOR UPDATE`,
        [sendId],
      ) as Array<{ id: string; student_id: string; on_date: string; rep_ids: unknown; body: string }>;
      const source = sources[0];
      if (!source) throw new NotFoundException({ code: 'REPORT_DELIVERY_NOT_FOUND', message: '발송 이력을 찾을 수 없습니다' });
      const blobs = await q.query(
        `SELECT file_url FROM pdflog
          WHERE kind='report_png' AND ref_id=$1 AND file_url IS NOT NULL ORDER BY id`,
        [sendId],
      ) as Array<{ file_url: string }>;
      if (blobs.length === 0) {
        throw new ConflictException({ code: 'REPORT_DELIVERY_FILES_MISSING', message: '재발송할 보존 파일이 없습니다' });
      }
      const inserted = await q.query(
        `INSERT INTO rsend (student_id, on_date, rep_ids, channel, body, sent_by, request_key, source_send_id)
         VALUES ($1,$2,$3::jsonb,'blob',$4,$5,$6,$7) RETURNING id`,
        [
          Number(source.student_id), source.on_date, JSON.stringify(source.rep_ids), source.body,
          actorId, requestKey, Number(source.id),
        ],
      ) as Array<{ id: string }>;
      newId = Number(inserted[0].id);
      await q.query(
        `INSERT INTO pdflog (kind, ref_id, file_url, rep_id)
         SELECT 'report_png', $1, file_url, rep_id FROM pdflog
          WHERE kind='report_png' AND ref_id=$2 AND file_url IS NOT NULL`,
        [newId, sendId],
      );
      await q.commitTransaction();
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      const e = error as { code?: string };
      if (e.code === '23505') {
        const raced = await this.idempotentResend(this.ds, requestKey, sendId);
        if (raced) return raced;
      }
      throw error;
    } finally {
      await q.release();
    }
    return this.requireHistoryItem(this.ds, newId);
  }

  async write(
    serId: number,
    onDate: string,
    dto: ReportUpsertDto,
    action: ReportWriteAction,
    actorId: number,
    canCrudAll: boolean,
    canApprove: boolean,
  ): Promise<ReportDetailDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      // 일정·출결과 부모→REP 순서를 공유한다. 잠금 대기 후 별도 SELECT로 joined 상태를 읽는다.
      await lockScheduleSeries(q, [serId]);
      const row = await this.loadDetail(q, serId, onDate, true);
      if (!row) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });

      const issue = reportWriteIssue({
        actorId,
        teacherId: row.teacher_id ? Number(row.teacher_id) : null,
        canCrudAll,
        reportable: row.reportable,
        canceled: row.canceled,
        ended: row.ended,
        state: row.state,
      });
      if (issue) this.throwWriteIssue(issue);

      const body: ReportBody = { content: dto.content, progress: dto.progress, homework: dto.homework };
      const emptyField = reportBodyIssue(body, action);
      if (emptyField) {
        const field = REPORT_FIELDS.find((item) => item.key === emptyField)!;
        throw new BadRequestException({ code: 'REPORT_FIELD_REQUIRED', message: `${field.label}을(를) 채워야 제출됩니다` });
      }

      const nextState: RepStateDb = action === 'submit' ? 'wait' : 'draft';
      await q.query(
        `UPDATE rep
            SET body = $2::jsonb,
                state = $3::rep_state_t,
                written_at = CASE WHEN $4::boolean THEN COALESCE(written_at, now()) ELSE written_at END,
                submitted_at = CASE WHEN $4::boolean THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
                reviewed_at = NULL,
                reviewer_id = NULL,
                reject_reason = NULL
          WHERE id = $1`,
        [row.id, JSON.stringify(body), nextState, action === 'submit'],
      );
      // N-73 — 다시 쓰면 결재 도장(reviewed_at · 반려 사유)이 지워진다. 무엇이 지워졌는지를 같은 트랜잭션에 남긴다.
      // 본문은 싣지 않는다(학생 기록 원문 — 원장은 「누가 언제 상태를 바꿨나」만 답한다).
      await audit(q, 'report.write', {
        actorId,
        entityId: row.id,
        before: { state: row.state, reviewedAt: row.reviewed_at, rejectReason: row.reject_reason },
        after: { state: nextState, submitted: action === 'submit' },
      });
      const saved = await this.loadDetail(q, serId, onDate);
      if (!saved) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });
      await q.commitTransaction();
      return this.toDetail(saved, actorId, canCrudAll, canApprove);
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }

  async review(
    serId: number,
    onDate: string,
    dto: ReportReviewDto,
    actorId: number,
    canCrudAll: boolean,
    canApprove: boolean,
  ): Promise<ReportDetailDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      // 승인 규칙은 그대로이며 최신 담당자·응답·알림 수신자를 같은 일정 snapshot에서 읽는다.
      await lockScheduleSeries(q, [serId]);
      const row = await this.loadDetail(q, serId, onDate, true);
      if (!row) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });

      const issue = reportReviewIssue({
        canApprove, state: row.state, decision: dto.decision, reason: dto.reason,
        // 자기 결재 금지 — 쓴 사람은 잠근 행에서 읽는다(요청이 보낸 값을 믿지 않는다)
        teacherId: row.teacher_id, actorId,
      });
      if (issue) this.throwReviewIssue(issue);

      const state: RepStateDb = dto.decision === 'approve' ? 'ok' : 'rej';
      const rejectReason = dto.decision === 'reject' ? dto.reason!.trim() : null;
      await q.query(
        `UPDATE rep
            SET state = $2::rep_state_t, reviewed_at = now(), reviewer_id = $3, reject_reason = $4
          WHERE id = $1`,
        [row.id, state, actorId, rejectReason],
      );
      await q.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after)
         VALUES ($1, 'REP', $2, $3, $4::jsonb, $5::jsonb)`,
        [actorId, row.id, dto.decision, JSON.stringify({ state: row.state }), JSON.stringify({ state, rejectReason })],
      );
      if (row.teacher_id) {
        await q.query(
          `INSERT INTO noti (to_id, from_id, body, link, category, title)
           VALUES ($1, $2, $3, '/reports', 'report', $4)`,
          [
            Number(row.teacher_id), actorId,
            dto.decision === 'approve'
              ? `${row.on_date} 리포트가 승인되었습니다.`
              : `${row.on_date} 리포트가 반려되었습니다: ${rejectReason}`,
            dto.decision === 'approve' ? NOTI_TITLE.reportApproved : NOTI_TITLE.reportRejected,
          ],
        );
      }

      const saved = await this.loadDetail(q, serId, onDate);
      if (!saved) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });
      await q.commitTransaction();
      return this.toDetail(saved, actorId, canCrudAll, canApprove);
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }
}
