/** @file-guide
 * 목적: guides.service.ts — GuidesService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { histSql } from '../../lib/history';
import { GUIDE_DONE_DB, GUIDE_PENDING_DB } from '../../lib/rules';
import type {
  GuideBodyDto, GuideDraftCreateDto, GuideDto, GuideHistoryDto, GuideHistoryQueryDto, GuideHistorySpan,
  GuideMissingDto, GuideStudentsDto, GuideTemplateDto, GuideTemplateWriteDto, GuidesDto,
} from './guides.dto';
import { END_MIN, kstAt, kstDateOf, START_MIN, writtenRows } from '../../lib/sql';
import { addDays, isIsoDate, overdueDays as overdue, todayKst } from '../../lib/kst';

type R = Record<string, unknown>;

const DELIVERY_UNSUPPORTED = '학부모 연락처와 외부 발송 제공자 계약이 없어 실제 발송은 아직 지원하지 않습니다';

/**
 * D-R5 누락 이벤트의 단일 계산식.
 * - SER_OCC의 현재 회차 투영과 그 회차의 학생 명단만 읽는다.
 * - 첫 참석 회차 또는 직전 참석 회차와 담당 강사가 달라진 회차만 이벤트다.
 * - GUIDE에는 재생성되는 SER_OCC.id 대신 `(ser_id,on_date,student_id,reason)`을 저장한다.
 */
const GUIDE_EVENT_CTE = `WITH rostered AS (
  SELECT o.id AS source_occurrence_id, o.ser_id, o.on_date AS source_on,
         to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS event_on,
         o.teacher_id, ss.student_id, st.name AS student_name,
         t.name AS teacher_name, s.title AS ser_title,
         row_number() OVER (PARTITION BY o.ser_id,ss.student_id ORDER BY o.on_date,o.id) AS seq,
         lag(o.teacher_id) OVER (PARTITION BY o.ser_id,ss.student_id ORDER BY o.on_date,o.id) AS previous_teacher_id
    FROM ser_occ o
    JOIN ser s ON s.id=o.ser_id
    JOIN ser_stu ss ON ss.ser_id=o.ser_id
    JOIN stu st ON st.id=ss.student_id
    LEFT JOIN staff t ON t.id=o.teacher_id
    LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
   WHERE NOT o.canceled
     AND NOT EXISTS (
       SELECT 1 FROM exc_stu_out xo
        WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id
     )
), events AS (
  SELECT *, CASE
    WHEN seq=1 THEN 'new'
    WHEN previous_teacher_id IS DISTINCT FROM teacher_id THEN 'teacher_change'
    ELSE NULL
  END AS reason
  FROM rostered
)`;


@Injectable()
export class GuidesService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  private async guideRows(where = '', params: unknown[] = [], manager?: EntityManager): Promise<GuideDto[]> {
    const run = manager
      ? (sql: string, p: unknown[]) => manager.query(sql, p) as Promise<R[]>
      : (sql: string, p: unknown[]) => this.q(sql, p);
    const rows = await run(
      `SELECT g.id,g.ser_id,g.student_id,g.teacher_id,g.reason,g.state,g.body,g.created_by,
              to_char(g.due_on,'YYYY-MM-DD') AS due_on,
              COALESCE(to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD'),to_char(g.event_on,'YYYY-MM-DD')) AS event_on,
              o.id AS source_occurrence_id,
              ${kstAt('g.created_at')} AS created_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by,
              (SELECT st.name FROM hist h LEFT JOIN staff st ON st.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send') AS sent_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by,
              (SELECT st.name FROM hist h LEFT JOIN staff st ON st.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack') AS acknowledged_at,
              s.name AS student_name,t.name AS teacher_name,r.title AS ser_title,cb.name AS created_by_name
         FROM guide g
         LEFT JOIN stu s ON s.id=g.student_id
         LEFT JOIN staff t ON t.id=g.teacher_id
         LEFT JOIN ser r ON r.id=g.ser_id
         LEFT JOIN staff cb ON cb.id=g.created_by
         LEFT JOIN ser_occ o ON o.ser_id=g.ser_id AND o.on_date=g.event_on
         ${where}
         ORDER BY g.created_at DESC,g.id DESC`,
      params,
    );
    return rows.map((row) => this.mapGuide(row));
  }

  private mapGuide(r: R): GuideDto {
    const pending = (GUIDE_PENDING_DB as readonly string[]).includes(String(r.state));
    return {
      id: Number(r.id), serId: r.ser_id == null ? null : Number(r.ser_id), studentId: Number(r.student_id),
      teacherId: r.teacher_id == null ? null : Number(r.teacher_id),
      reason: String(r.reason), state: String(r.state), pending,
      studentName: (r.student_name as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      serTitle: (r.ser_title as string) ?? null,
      body: (r.body as string) ?? null,
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
    };
  }

  /** teacherId 가 있으면 그 강사 것만 — 화면이 안 걸러도 서버가 거른다 (D-R39). */
  async all(teacherId?: number): Promise<GuidesDto> {
    const only = teacherId !== undefined;
    const guides = await this.guideRows(`WHERE ($1::bigint IS NULL OR g.teacher_id=$1)`, [only ? teacherId : null]);

    const perRows = await this.q(
      `SELECT o.id AS source_occurrence_id,o.ser_id,
              to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS on_date,
              ${START_MIN} AS start_min,${END_MIN} AS end_min,
              o.teacher_id,t.name AS teacher_name,r.title AS ser_title,k.name AS kind_name,
              o.zacc_id,z.label AS zacc_label,ss.student_id,st.name AS student_name,
              p.id AS notice_id,p.channel,p.body,${kstAt('p.sent_at')} AS sent_at
         FROM ser_occ o
         JOIN ser r ON r.id=o.ser_id AND r.mode='online'::class_mode_t
         JOIN kind k ON k.key=r.kind_key
         JOIN ser_stu ss ON ss.ser_id=o.ser_id
         JOIN stu st ON st.id=ss.student_id
         LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
         LEFT JOIN staff t ON t.id=o.teacher_id
         LEFT JOIN zacc z ON z.id=o.zacc_id
         LEFT JOIN LATERAL (
           SELECT pn.id,pn.channel,pn.body,pn.sent_at
             FROM pnoti pn
            WHERE pn.ser_id=o.ser_id AND pn.on_date=o.on_date AND pn.student_id=ss.student_id
            ORDER BY pn.id DESC
            LIMIT 1
         ) p ON true
        WHERE NOT o.canceled
          AND ${kstDateOf('lower(o.span)')}=$1::date
          AND ($2::bigint IS NULL OR o.teacher_id=$2)
          AND NOT EXISTS (
            SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id
          )
        ORDER BY lower(o.span),o.id,st.name,st.id,p.id DESC`,
      [todayKst(), only ? teacherId : null],
    );
    const byOccurrence = new Map<number, R[]>();
    for (const row of perRows) {
      const id = Number(row.source_occurrence_id);
      byOccurrence.set(id, [...(byOccurrence.get(id) ?? []), row]);
    }
    const perLesson = [...byOccurrence.values()].map((rows) => {
      const first = rows[0];
      const notices = rows.map((row) => ({
        id: row.notice_id == null ? null : Number(row.notice_id),
        studentId: Number(row.student_id), studentName: String(row.student_name),
        channel: (row.channel as string) ?? null, body: (row.body as string) ?? null,
        sentAt: (row.sent_at as string) ?? null,
      }));
      const recorded = notices.length > 0 && notices.every((notice) => notice.sentAt !== null);
      const firstNotice = notices.find((notice) => notice.id !== null);
      return {
        id: Number(first.source_occurrence_id), sourceOccurrenceId: Number(first.source_occurrence_id),
        serId: Number(first.ser_id), onDate: String(first.on_date),
        startMin: Number(first.start_min), endMin: Number(first.end_min),
        teacherId: first.teacher_id == null ? null : Number(first.teacher_id),
        teacherName: (first.teacher_name as string) ?? null,
        kindName: (first.kind_name as string) ?? null,
        zaccId: first.zacc_id == null ? null : Number(first.zacc_id),
        zaccLabel: (first.zacc_label as string) ?? null,
        zoomAssigned: first.zacc_id != null,
        notices, parentDeliveryRecorded: recorded, teacherDeliveryRecorded: false,
        channel: firstNotice?.channel ?? 'app',
        studentName: notices.map((notice) => notice.studentName).join(', '),
        serTitle: (first.ser_title as string) ?? null,
        body: firstNotice?.body ?? '',
        sentAt: recorded ? notices.map((notice) => notice.sentAt).sort().at(-1) ?? null : null,
      };
    });

    const teacherChanges = new Map<string, number>();
    for (const guide of guides.filter((guide) => guide.reason === 'teacher_change')) {
      const key = `${guide.studentId}|${guide.serId ?? 'none'}`;
      teacherChanges.set(key, (teacherChanges.get(key) ?? 0) + 1);
    }
    const stats = {
      monitoring: new Set(guides.map((guide) => guide.studentId)).size,
      overdue: guides.filter((guide) => guide.pending && guide.overdueDays > 0).length,
      drafting: guides.filter((guide) => guide.state === 'draft').length,
      sendPending: guides.filter((guide) => guide.state === 'ready').length,
      teacherUnconfirmed: guides.filter((guide) => guide.state === 'sent').length,
      repeatedTeacherChange: [...teacherChanges.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    };
    return {
      guides,
      perLesson,
      todoCount:
        guides.filter((g) => g.pending).length +
        perLesson.filter((notice) => !notice.parentDeliveryRecorded || !notice.teacherDeliveryRecorded).length,
      scopedTeacherId: only ? teacherId! : null,
      stats,
      deliveryCapabilities: {
        parentExternal: false,
        teacherExternal: false,
        reason: DELIVERY_UNSUPPORTED,
      },
    };
  }

  /** §44 학생별 — 학생의 최신 GUIDE와 같은 학생의 교재·진단을 한 projection으로 묶는다. */
  async students(): Promise<GuideStudentsDto> {
    const latest = await this.q(
      `WITH ranked AS (
         SELECT g.*,count(*) OVER (PARTITION BY g.student_id)::int AS guide_count,
                row_number() OVER (PARTITION BY g.student_id ORDER BY g.created_at DESC,g.id DESC) AS rn
           FROM guide g
       )
       SELECT g.id,g.ser_id,g.student_id,g.teacher_id,g.reason,g.state,g.body,g.guide_count,g.created_by,
              to_char(g.due_on,'YYYY-MM-DD') AS due_on,
              COALESCE(to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD'),to_char(g.event_on,'YYYY-MM-DD')) AS event_on,
              o.id AS source_occurrence_id,${kstAt('g.created_at')} AS created_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by,
              (SELECT sx.name FROM hist h LEFT JOIN staff sx ON sx.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send' ORDER BY h.at,h.id LIMIT 1) AS sent_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_send') AS sent_at,
              (SELECT h.by_id FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by,
              (SELECT sx.name FROM hist h LEFT JOIN staff sx ON sx.id=h.by_id WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack' ORDER BY h.at,h.id LIMIT 1) AS acknowledged_by_name,
              (SELECT ${kstAt('min(h.at)')} FROM hist h WHERE h.entity='guide' AND h.ref_id=g.id AND h.action='guide_ack') AS acknowledged_at,
              st.name AS student_name,st.grade,st.guidance,st.lang,
              t.name AS teacher_name,s.title AS ser_title,cb.name AS created_by_name
         FROM ranked g JOIN stu st ON st.id=g.student_id
         LEFT JOIN staff t ON t.id=g.teacher_id LEFT JOIN ser s ON s.id=g.ser_id
         LEFT JOIN staff cb ON cb.id=g.created_by
         LEFT JOIN ser_occ o ON o.ser_id=g.ser_id AND o.on_date=g.event_on
        WHERE g.rn=1 ORDER BY st.name,st.id`,
    );
    const ids = latest.map((row) => Number(row.student_id));
    if (ids.length === 0) return { items: [] };
    const books = await this.q(
      `SELECT i.id AS issue_id,i.student_id,i.lib_id,i.vers_id,l.code,l.title,l.se_te,l.sub_key,v.edition
         FROM issue i JOIN lib l ON l.id=i.lib_id LEFT JOIN vers v ON v.id=i.vers_id
        WHERE i.student_id=ANY($1::bigint[]) AND i.state <> 'returned'
        ORDER BY i.student_id,l.title,i.id`, [ids],
    );
    const diagnostics = await this.q(
      `SELECT DISTINCT ON (d.student_id) d.id,d.student_id,d.level_summary,d.strengths,d.weaknesses,d.curriculum,
              ${kstAt('d.created_at')} AS created_at
         FROM diag d WHERE d.student_id=ANY($1::bigint[])
        ORDER BY d.student_id,d.created_at DESC,d.id DESC`, [ids],
    );
    return {
      items: latest.map((row) => ({
        studentId: Number(row.student_id), studentName: String(row.student_name),
        grade: (row.grade as string) ?? null, guidance: (row.guidance as string) ?? null, lang: (row.lang as string) ?? null,
        guideCount: Number(row.guide_count), latestGuide: this.mapGuide(row),
        books: books.filter((book) => Number(book.student_id) === Number(row.student_id)).map((book) => ({
          issueId: Number(book.issue_id), libId: Number(book.lib_id),
          versId: book.vers_id === null ? null : Number(book.vers_id), code: String(book.code), title: String(book.title),
          edition: (book.edition as string) ?? null, seTe: (book.se_te as string) ?? null, subKey: (book.sub_key as string) ?? null,
        })),
        diagnostic: (() => {
          const diag = diagnostics.find((item) => Number(item.student_id) === Number(row.student_id));
          return diag ? {
            id: Number(diag.id), levelSummary: String(diag.level_summary),
            strengths: (diag.strengths as string) ?? null, weaknesses: (diag.weaknesses as string) ?? null,
            curriculum: (diag.curriculum as string) ?? null, createdAt: String(diag.created_at),
          } : null;
        })(),
      })),
    };
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
  ): Promise<GuideMissingDto[]> {
    const run = manager
      ? manager.query.bind(manager) as (sql: string, params: unknown[]) => Promise<R[]>
      : (sql: string, params: unknown[]) => this.q(sql, params);
    const rows = await run(
      `${GUIDE_EVENT_CTE}
       SELECT e.source_occurrence_id,e.event_on,e.ser_id,e.student_id,e.student_name,
              e.teacher_id,e.teacher_name,e.ser_title,e.reason
         FROM events e
        WHERE e.reason IS NOT NULL
          AND ($1::date IS NULL OR e.event_on::date >= $1::date)
          AND ($2::date IS NULL OR e.event_on::date <= $2::date)
          AND ($3::bigint IS NULL OR e.source_occurrence_id=$3)
          AND ($4::bigint IS NULL OR e.student_id=$4)
          AND ($5::boolean OR NOT EXISTS (
            SELECT 1 FROM guide g
             WHERE g.ser_id=e.ser_id AND g.event_on=e.source_on
               AND g.student_id=e.student_id AND g.reason=e.reason
          ))
        ORDER BY e.event_on DESC,e.source_occurrence_id,e.student_name`,
      [from, to, sourceOccurrenceId, studentId, includeSatisfied],
    );
    return rows.map((row) => ({
      sourceOccurrenceId: Number(row.source_occurrence_id), eventOn: String(row.event_on),
      serId: Number(row.ser_id), studentId: Number(row.student_id), studentName: String(row.student_name),
      teacherId: row.teacher_id === null ? null : Number(row.teacher_id),
      teacherName: (row.teacher_name as string) ?? null, serTitle: (row.ser_title as string) ?? null,
      reason: String(row.reason),
    }));
  }

  /** §45 날짜 이력과 같은 기간의 '필요하지만 없는' D-R5 이벤트. */
  async history(query: GuideHistoryQueryDto): Promise<GuideHistoryDto> {
    const span = query.span ?? 'month';
    const anchor = query.anchor ?? todayKst();
    const { from, to } = this.range(span, anchor);
    const [guides, missing] = await Promise.all([
      this.guideRows(
        `WHERE COALESCE(${kstDateOf('lower(o.span)')},g.event_on,g.due_on,${kstDateOf('g.created_at')}) BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      this.candidateRows(from, to, null, null, false),
    ]);
    const grouped = new Map<string, GuideDto[]>();
    for (const guide of guides) {
      const date = guide.eventOn ?? guide.dueOn ?? guide.createdAt.slice(0, 10);
      grouped.set(date, [...(grouped.get(date) ?? []), guide]);
    }
    const days = [...grouped.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, items]) => ({ date, items }));
    return {
      span, anchor, from, to, missing, days,
      counts: {
        created: guides.length,
        sent: guides.filter((guide) => (GUIDE_DONE_DB as readonly string[]).includes(guide.state)).length,
        missing: missing.length,
      },
    };
  }

  /** §45 누락 카드 클릭 — 클라이언트 이유를 믿지 않고 현재 SER_OCC에서 다시 판정한다. */
  async createDraft(userId: number, dto: GuideDraftCreateDto): Promise<GuideDto> {
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
      const made = await manager.query(
        `INSERT INTO guide (ser_id,student_id,teacher_id,reason,state,due_on,event_on,created_by)
         VALUES ($1,$2,$3,$4,'draft'::guide_state_t,$5::date,$6::date,$7)
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
    const [guide] = await this.guideRows(`WHERE g.id=$1`, [id]);
    if (!guide) throw new NotFoundException('생성한 안내를 찾을 수 없습니다');
    return guide;
  }

  /* ══ §43 머리의 「문구 관리」 — 문구 틀 (C51) ═══════════════════════════════ */

  async templates(): Promise<GuideTemplateDto[]> {
    const rows = await this.q(`SELECT id, name, body FROM gtpl ORDER BY name`);
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name), body: String(r.body) }));
  }

  /**
   * 틀을 하나 만든다. **이름이 겹치면 막는다** — 목록에서 이름으로 고르는데
   * 같은 이름이 둘이면 어느 것을 골랐는지 화면이 말할 수 없다.
   */
  async createTemplate(dto: GuideTemplateWriteDto): Promise<GuideTemplateDto> {
    const name = dto.name.trim();
    const dup = await this.q(`SELECT id FROM gtpl WHERE name = $1`, [name]);
    if (dup.length > 0) {
      throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
    }
    let made: R;
    try {
      [made] = await this.q(
        `INSERT INTO gtpl (name, body) VALUES ($1, $2) RETURNING id, name, body`, [name, dto.body],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
      }
      throw error;
    }
    return { id: Number(made.id), name: String(made.name), body: String(made.body) };
  }

  /**
   * 틀을 고친다. **이미 쓴 안내는 안 바뀐다** — 안내는 본문을 복사해 갖고 있다.
   * 보낸 말이 나중에 달라지면 안 되기 때문이고, 그래서 `guide` 에 `gtpl_id` 가 없다.
   */
  async patchTemplate(id: number, dto: GuideTemplateWriteDto): Promise<GuideTemplateDto> {
    const name = dto.name.trim();
    const dup = await this.q(`SELECT id FROM gtpl WHERE name = $1 AND id <> $2`, [name, id]);
    if (dup.length > 0) {
      throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
    }
    let rows: R[];
    try {
      rows = await this.q(
        `UPDATE gtpl SET name = $2, body = $3 WHERE id = $1 RETURNING id, name, body`, [id, name, dto.body],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'GTPL_DUPLICATE', message: `「${name}」는 이미 있는 문구입니다` });
      }
      throw error;
    }
    const [row] = writtenRows<R>(rows);
    if (!row) throw new NotFoundException('문구를 찾을 수 없습니다');
    return { id: Number(row.id), name: String(row.name), body: String(row.body) };
  }

  /* ══ §43 「안내 작성」 (C51) ═══════════════════════════════════════════════ */

  /**
   * 안내 본문을 쓴다 — 쓰면 **보낼 준비**가 된다.
   *
   * 상태 낱말은 화면이 정하지 않는다(D-R18). 화면은 「썼다」만 말하고 어느 상태가 되는지는
   * 여기가 정한다. 이미 보낸 안내는 **고치지 않는다** — 학부모가 받은 말과 장부가 갈린다.
   * 되돌리기가 필요하면 새 안내를 만드는 것이 원문의 방식이다(§53 규칙 줄과 같은 결).
   */
  async writeBody(userId: number, id: number, dto: GuideBodyDto): Promise<GuidesDto['guides'][number]> {
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
      const rows = writtenRows<R>(await m.query(
        `UPDATE guide SET body=$2,state='ready'::guide_state_t
          WHERE id=$1 AND state=ANY($3::guide_state_t[]) RETURNING id`,
        [id, dto.body, [...GUIDE_PENDING_DB]],
      ));
      if (!rows[0]) throw new ConflictException({ code: 'GUIDE_STATE_CHANGED', message: '안내 상태가 변경되었습니다' });
      await m.query(histSql(), ['guide', id, 'guide_write', userId]);
    });
    const [found] = await this.guideRows(`WHERE g.id=$1`, [id]);
    if (!found) throw new NotFoundException('안내를 찾을 수 없습니다');
    return found;
  }

}
