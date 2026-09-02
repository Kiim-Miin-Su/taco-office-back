import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  LATE_REPORT_TIERS, REPORT_FIELDS, REPORT_UNWRITTEN_CANDIDATE_DB,
  effectiveRepStateFromEnded, isWrittenDbState, reportBodyIssue, reportWriteIssue, tierFor,
  type RepStateDb, type ReportBody, type ReportWriteAction, type ReportWriteIssue,
} from '../../lib/rules';
import { START_MIN } from '../../lib/sql';
import type {
  ReportDetailDto, ReportRowDto, ReportUpsertDto, UnwrittenDto,
} from './reports.dto';

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
  students: Array<{ id: number; name: string; grade: string | null }> | null;
}

interface DetailRow extends Row {
  body: unknown;
  lang: string;
  written_at: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
}

interface Queryer {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

const WRITE_ERRORS: Record<ReportWriteIssue, { message: string; status: 'bad' | 'forbidden' | 'conflict' }> = {
  REPORT_NOT_ALLOWED: { message: '리포트 대상 수업이 아닙니다', status: 'bad' },
  REPORT_CANCELED: { message: '취소된 회차에는 리포트를 쓸 수 없습니다', status: 'bad' },
  REPORT_NOT_ENDED: { message: '수업이 끝난 뒤에 리포트를 저장할 수 있습니다', status: 'bad' },
  REPORT_FORBIDDEN: { message: '담당 강사 또는 전체 관리 권한이 필요합니다', status: 'forbidden' },
  REPORT_LOCKED: { message: '제출 대기 또는 승인된 리포트는 고칠 수 없습니다', status: 'conflict' },
};

@Injectable()
export class ReportsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

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
                     SELECT json_agg(json_build_object('id', st.id, 'name', st.name, 'grade', st.grade) ORDER BY st.id)
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

  private static detailSql(lock: boolean): string {
    return `SELECT r.id, r.ser_id,
                   to_char(COALESCE(lower(o.span) AT TIME ZONE 'Asia/Seoul', r.on_date::timestamp), 'YYYY-MM-DD') AS date,
                   to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   ${START_MIN} AS start_min,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   COALESCE(r.kind_key, s.kind_key) AS kind_key, s.sub_key,
                   COALESCE(o.teacher_id, r.teacher_id) AS teacher_id, t.name AS teacher_name, r.state,
                   r.body, r.lang, k.rep AS reportable, COALESCE(o.canceled, false) AS canceled,
                   COALESCE(upper(o.span) <= now(), false) AS ended,
                   to_char(r.written_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS written_at,
                   to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
                   to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
                   r.reject_reason,
                   COALESCE((
                     SELECT json_agg(json_build_object('id', st.id, 'name', st.name, 'grade', st.grade) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
              LEFT JOIN staff t ON t.id = COALESCE(o.teacher_id, r.teacher_id)
             WHERE r.ser_id = $1 AND r.on_date = $2
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
      students: (r.students ?? []).map((s) => ({ id: Number(s.id), name: s.name, grade: s.grade })),
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

  private toDetail(r: DetailRow, actorId: number, canCrudAll: boolean): ReportDetailDto {
    return {
      ...this.toRow(r, new Date()),
      body: this.body(r.body),
      fields: REPORT_FIELDS.map((field) => ({ ...field })),
      canEdit: this.canEdit(r, actorId, canCrudAll),
      lang: r.lang,
      writtenAt: r.written_at,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      rejectReason: r.reject_reason,
    };
  }

  private async loadDetail(q: Queryer, serId: number, onDate: string, lock = false): Promise<DetailRow | null> {
    const rows = await q.query<DetailRow[]>(ReportsService.detailSql(lock), [serId, onDate]);
    return rows[0] ?? null;
  }

  private throwWriteIssue(issue: ReportWriteIssue): never {
    const error = WRITE_ERRORS[issue];
    const body = { code: issue, message: error.message };
    if (error.status === 'forbidden') throw new ForbiddenException(body);
    if (error.status === 'conflict') throw new ConflictException(body);
    throw new BadRequestException(body);
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

  async detail(serId: number, onDate: string, actorId: number, canCrudAll: boolean): Promise<ReportDetailDto> {
    const row = await this.loadDetail(this.ds, serId, onDate);
    if (!row) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: '리포트를 찾을 수 없습니다' });
    if (actorId !== Number(row.teacher_id) && !canCrudAll) this.throwWriteIssue('REPORT_FORBIDDEN');
    return this.toDetail(row, actorId, canCrudAll);
  }

  async write(
    serId: number,
    onDate: string,
    dto: ReportUpsertDto,
    action: ReportWriteAction,
    actorId: number,
    canCrudAll: boolean,
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
      return this.toDetail(saved, actorId, canCrudAll);
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }
}
