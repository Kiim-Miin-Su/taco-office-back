import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  LATE_REPORT_TIERS, REPORT_FIELDS, REPORT_UNWRITTEN_CANDIDATE_DB,
  canExportReport, decodeReportPng, effectiveRepStateFromEnded, isWrittenDbState, reportBodyIssue,
  reportDeliveryIssue, reportPlainText, reportPngFileName, reportReviewIssue, reportWriteIssue, tierFor,
  type RepStateDb, type ReportBody, type ReportDeliveryIssue, type ReportPngIssue,
  type ReportReviewIssue, type ReportWriteAction, type ReportWriteIssue,
} from '../../lib/rules';
import { START_MIN } from '../../lib/sql';
import type {
  ReportDeliveryCreateDto, ReportDeliveryQueueDto, ReportDetailDto, ReportReviewDto, ReportRowDto,
  ReportSendHistoryDto, ReportUpsertDto, UnwrittenDto,
} from './reports.dto';
import { REPORT_FILE_STORE, type ReportFileStore } from './report-file.store';

interface Row {
  id: string;
  ser_id: string;
  date: string;
  on_date: string;
  start_min: number;
  end_min_utc: string | null;
  sub_key: string | null;
  kind_key: string;
  teacher_id: string | null;
  teacher_name: string | null;
  state: RepStateDb;
  reportable: boolean;
  canceled: boolean;
  ended: boolean;
  students: Array<{ id: number; name: string; grade: string | null; deliver: boolean }> | null;
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

@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REPORT_FILE_STORE) private readonly files: ReportFileStore,
  ) {}

  private static sql(where: string): string {
    return `SELECT r.id, r.ser_id,
                   to_char(COALESCE(lower(o.span) AT TIME ZONE 'Asia/Seoul', r.on_date::timestamp), 'YYYY-MM-DD') AS date,
                   to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   ${START_MIN} AS start_min,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   COALESCE(r.kind_key, s.kind_key) AS kind_key, s.sub_key,
                   COALESCE(o.teacher_id, r.teacher_id) AS teacher_id, t.name AS teacher_name, r.state,
                   k.rep AS reportable, COALESCE(o.canceled, false) AS canceled,
                   COALESCE(upper(o.span) <= now(), false) AS ended,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'id', st.id, 'name', st.name, 'grade', st.grade, 'deliver', rs.deliver
                     ) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
             WHERE ${where}
             ORDER BY date DESC, start_min DESC`;
  }

  private static detailSql(where: string, lock: boolean): string {
    return `SELECT r.id, r.ser_id,
                   to_char(COALESCE(lower(o.span) AT TIME ZONE 'Asia/Seoul', r.on_date::timestamp), 'YYYY-MM-DD') AS date,
                   to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   ${START_MIN} AS start_min,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   COALESCE(r.kind_key, s.kind_key) AS kind_key, s.sub_key,
                   COALESCE(o.teacher_id, r.teacher_id) AS teacher_id, t.name AS teacher_name, r.state,
                   r.body, r.lang, COALESCE(sb.name, s.title, k.name) AS subject_name,
                   k.rep AS reportable, COALESCE(o.canceled, false) AS canceled,
                   COALESCE(upper(o.span) <= now(), false) AS ended,
                   to_char(r.written_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS written_at,
                   to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
                   to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
                   r.reject_reason,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'id', st.id, 'name', st.name, 'grade', st.grade, 'deliver', rs.deliver
                     ) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
              LEFT JOIN sub sb ON sb.key = s.sub_key
              LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
             WHERE ${where}
             ORDER BY r.on_date, start_min, r.id
             ${lock ? 'FOR UPDATE OF r' : ''}`;
  }

  /** 판정은 rules.ts 한 곳에서만 — 화면도 이 결과를 읽기만 한다. */
  private toRow(r: Row, now: Date): ReportRowDto {
    const end = r.end_min_utc ? new Date(r.end_min_utc) : null;
    const minutesSinceEnd = end ? Math.floor((now.getTime() - end.getTime()) / 60000) : -1;
    const state = effectiveRepStateFromEnded(r.state, r.reportable, r.ended);
    const written = isWrittenDbState(state);
    const penalty = written || minutesSinceEnd < 0 ? 0 : tierFor(minutesSinceEnd).amount;
    return {
      id: Number(r.id), serId: Number(r.ser_id), date: r.date, onDate: r.on_date, startMin: r.start_min,
      subKey: r.sub_key, kindKey: r.kind_key,
      teacherId: r.teacher_id ? Number(r.teacher_id) : null, teacherName: r.teacher_name,
      state, written, minutesSinceEnd, penalty,
      students: (r.students ?? []).map((s) => ({
        id: Number(s.id), name: s.name, grade: s.grade, deliver: Boolean(s.deliver),
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
      canReview: reportReviewIssue({
        canApprove, state: r.state, decision: 'approve',
      }) === null,
      canExport,
      exportFiles: canExport ? row.students.map((student) => ({
        studentId: student.id,
        fileName: reportPngFileName({
          date: row.date,
          studentName: student.name,
          studentGrade: student.grade,
          subjectName: r.subject_name,
          startMin: row.startMin,
        }),
        plainText: reportPlainText({
          date: row.date,
          studentName: student.name,
          studentGrade: student.grade,
          subjectName: r.subject_name,
          startMin: row.startMin,
          body,
        }),
      })) : [],
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
    const where = studentId === undefined
      ? `r.on_date = $1 AND EXISTS (SELECT 1 FROM rep_stu x WHERE x.rep_id = r.id AND x.deliver)`
      : `r.on_date = $1 AND EXISTS (
           SELECT 1 FROM rep_stu x
            WHERE x.rep_id = r.id AND x.student_id = $2 AND x.deliver
         )`;
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
      if (!expected || expected.fileName !== input.fileName) {
        this.throwDeliveryIssue('REPORT_DELIVERY_FILES_MISMATCH');
      }
      const decoded = decodeReportPng(input.pngDataUrl);
      if (decoded.issue) this.throwDeliveryIssue(decoded.issue);
      return { repId, fileName: expected.fileName, plainText: expected.plainText, bytes: decoded.bytes };
    });
  }

  private static historyRow(row: SendHistoryRow): ReportSendHistoryDto {
    const repIds = Array.isArray(row.rep_ids)
      ? row.rep_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    return {
      id: Number(row.id), sourceSendId: row.source_send_id ? Number(row.source_send_id) : null,
      studentId: Number(row.student_id), studentName: row.student_name,
      onDate: row.on_date, repIds, channel: row.channel, fileCount: Number(row.file_count),
      sentAt: row.sent_at, sentBy: Number(row.sent_by), sentByName: row.sent_by_name,
    };
  }

  private async historyItem(q: Queryer, sendId: number): Promise<ReportSendHistoryDto | null> {
    const rows = await q.query<SendHistoryRow[]>(
      `SELECT rs.id, rs.source_send_id, rs.student_id, st.name AS student_name,
              to_char(rs.on_date, 'YYYY-MM-DD') AS on_date,
              rs.rep_ids, rs.channel,
              to_char(rs.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
              rs.sent_by, sf.name AS sent_by_name,
              (SELECT count(*) FROM pdflog p WHERE p.kind='report_png' AND p.ref_id=rs.id)::text AS file_count
         FROM rsend rs JOIN stu st ON st.id=rs.student_id JOIN staff sf ON sf.id=rs.sent_by
        WHERE rs.id=$1`,
      [sendId],
    );
    return rows[0] ? ReportsService.historyRow(rows[0]) : null;
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

  private requireDeliveryPermission(canCrudAll: boolean): void {
    const issue = reportDeliveryIssue({
      canCrudAll, states: [], expectedRepIds: [], actualRepIds: [],
    });
    if (issue === 'REPORT_DELIVERY_FORBIDDEN') this.throwDeliveryIssue(issue);
  }

  async list(opts: { from?: string; to?: string; teacherId?: number; state?: string }): Promise<ReportRowDto[]> {
    const p: unknown[] = [];
    const c: string[] = ['1=1'];
    if (opts.from) { p.push(opts.from); c.push(`r.on_date >= $${p.length}`); }
    if (opts.to) { p.push(opts.to); c.push(`r.on_date <= $${p.length}`); }
    if (opts.teacherId) { p.push(opts.teacherId); c.push(`COALESCE(o.teacher_id, r.teacher_id) = $${p.length}`); }
    const rows = await this.ds.query<Row[]>(ReportsService.sql(c.join(' AND ')), p);
    const now = new Date();
    const items = rows.map((r) => this.toRow(r, now));
    return opts.state ? items.filter((item) => item.state === opts.state) : items;
  }

  /** §47 안 쓴 리포트 — 강사별로 몇 건 밀렸는지. */
  async unwritten(teacherId?: number): Promise<UnwrittenDto> {
    const p: unknown[] = [REPORT_UNWRITTEN_CANDIDATE_DB];
    const c = [
      `r.state = ANY($${p.length}::rep_state_t[])`,
      `k.rep`,
      `NOT COALESCE(o.canceled, false)`,
      `upper(o.span) < now()`,
    ];
    if (teacherId) { p.push(teacherId); c.push(`COALESCE(o.teacher_id, r.teacher_id) = $${p.length}`); }
    const rows = await this.ds.query<Row[]>(ReportsService.sql(c.join(' AND ')), p);
    const now = new Date();
    const items = rows.map((r) => this.toRow(r, now));

    const g = new Map<number, { name: string; items: ReportRowDto[] }>();
    for (const it of items) {
      if (!it.teacherId) continue;
      const cur = g.get(it.teacherId) ?? { name: it.teacherName ?? '-', items: [] };
      cur.items.push(it);
      g.set(it.teacherId, cur);
    }
    const [t1, t4] = [LATE_REPORT_TIERS[1].fromMinutes, LATE_REPORT_TIERS[0].fromMinutes];
    const byTeacher = [...g.entries()]
      .map(([teacherId2, v]) => ({
        teacherId: teacherId2,
        teacherName: v.name,
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
    opts: { onDate?: string; repId?: number }, canCrudAll: boolean,
  ): Promise<ReportSendHistoryDto[]> {
    this.requireDeliveryPermission(canCrudAll);
    const p: unknown[] = [];
    const where: string[] = ['1=1'];
    if (opts.onDate) { p.push(opts.onDate); where.push(`rs.on_date=$${p.length}`); }
    if (opts.repId) { p.push(JSON.stringify([opts.repId])); where.push(`rs.rep_ids @> $${p.length}::jsonb`); }
    const rows = await this.ds.query<SendHistoryRow[]>(
      `SELECT rs.id, rs.source_send_id, rs.student_id, st.name AS student_name,
              to_char(rs.on_date, 'YYYY-MM-DD') AS on_date,
              rs.rep_ids, rs.channel,
              to_char(rs.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
              rs.sent_by, sf.name AS sent_by_name,
              (SELECT count(*) FROM pdflog x WHERE x.kind='report_png' AND x.ref_id=rs.id)::text AS file_count
         FROM rsend rs JOIN stu st ON st.id=rs.student_id JOIN staff sf ON sf.id=rs.sent_by
        WHERE ${where.join(' AND ')}
        ORDER BY rs.sent_at DESC, rs.id DESC LIMIT 100`,
      p,
    );
    return rows.map(ReportsService.historyRow);
  }

  private async sendForRequest(q: Queryer, requestKey: string): Promise<RequestSendRow | null> {
    const rows = await q.query<RequestSendRow[]>(
      `SELECT id, student_id, to_char(on_date, 'YYYY-MM-DD') AS on_date, rep_ids, source_send_id
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

  private async idempotentDelivery(
    q: Queryer, requestKey: string, studentId: number, onDate: string, repIds: number[],
  ): Promise<ReportSendHistoryDto | null> {
    const prior = await this.sendForRequest(q, requestKey);
    if (!prior) return null;
    const savedRepIds = Array.isArray(prior.rep_ids) ? prior.rep_ids.map(Number).sort((a, b) => a - b) : [];
    const askedRepIds = [...repIds].sort((a, b) => a - b);
    const sameRepIds = savedRepIds.length === askedRepIds.length
      && savedRepIds.every((id, index) => id === askedRepIds[index]);
    if (
      Number(prior.student_id) !== studentId || prior.on_date !== onDate
      || prior.source_send_id !== null || !sameRepIds
    ) this.requestKeyConflict();
    return this.requireHistoryItem(q, Number(prior.id));
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
    const prior = await this.idempotentDelivery(
      this.ds, dto.requestKey, dto.studentId, dto.onDate, dto.files.map((file) => file.repId),
    );
    if (prior) return prior;

    const rows = await this.deliveryRows(this.ds, dto.onDate, dto.studentId);
    const prepared = this.deliveryFiles(rows, dto, actorId);
    const existing = await this.ds.query<Array<{ id: string }>>(
      `SELECT id FROM rsend WHERE student_id=$1 AND on_date=$2 AND source_send_id IS NULL LIMIT 1`,
      [dto.studentId, dto.onDate],
    );
    if (existing[0]) {
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
    await q.connect();
    await q.startTransaction();
    let committed = false;
    let sendId = 0;
    try {
      const lockedRows = await this.deliveryRows(q, dto.onDate, dto.studentId, true);
      const locked = this.deliveryFiles(lockedRows, dto, actorId);
      if (locked.some((file, index) => file.fileName !== prepared[index]?.fileName)) {
        this.throwDeliveryIssue('REPORT_DELIVERY_FILES_MISMATCH');
      }
      const idempotent = await this.idempotentDelivery(
        q, dto.requestKey, dto.studentId, dto.onDate, dto.files.map((file) => file.repId),
      );
      if (idempotent) {
        await q.rollbackTransaction();
        await this.files.delete(urls).catch(() => undefined);
        return idempotent;
      }
      const sent = await q.query(
        `INSERT INTO rsend (student_id, on_date, rep_ids, channel, body, sent_by, request_key, source_send_id)
         VALUES ($1,$2,$3::jsonb,'blob',$4,$5,$6,NULL) RETURNING id`,
        [
          dto.studentId, dto.onDate, JSON.stringify(locked.map((file) => file.repId)),
          locked.map((file) => file.plainText).join('\n\n────────\n\n'), actorId, dto.requestKey,
        ],
      ) as Array<{ id: string }>;
      sendId = Number(sent[0].id);
      await q.query(
        `INSERT INTO pdflog (kind, ref_id, file_url)
         SELECT 'report_png', $1, value FROM unnest($2::text[]) AS value`,
        [sendId, urls],
      );
      await q.commitTransaction();
      committed = true;
    } catch (error) {
      if (q.isTransactionActive) await q.rollbackTransaction();
      if (!committed) await this.files.delete(urls).catch(() => undefined);
      const e = error as { code?: string; constraint?: string };
      if (e.code === '23505') {
        const raced = await this.idempotentDelivery(
          this.ds, dto.requestKey, dto.studentId, dto.onDate, dto.files.map((file) => file.repId),
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
        `INSERT INTO pdflog (kind, ref_id, file_url)
         SELECT 'report_png', $1, file_url FROM pdflog
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
        [row.id, JSON.stringify(body), action === 'submit' ? 'wait' : 'draft', action === 'submit'],
      );
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
      const row = await this.loadDetail(q, serId, onDate, true);
      if (!row) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });

      const issue = reportReviewIssue({
        canApprove, state: row.state, decision: dto.decision, reason: dto.reason,
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
          `INSERT INTO noti (to_id, from_id, body, link)
           VALUES ($1, $2, $3, '/reports')`,
          [
            Number(row.teacher_id), actorId,
            dto.decision === 'approve'
              ? `${row.on_date} 리포트가 승인되었습니다.`
              : `${row.on_date} 리포트가 반려되었습니다: ${rejectReason}`,
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
