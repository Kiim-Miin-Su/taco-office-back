/** @file-guide
 * 목적: lead-diag.service.ts — LeadDiagService, LEAD_DIAG_LATEST_JOIN, leadDiagFromRow, latestLeadDiagForStudent (service)
 * 책임/재사용: 상담 진단 점수의 읽기 한 벌(SELECT·매핑)과 append 쓰기를 소유한다. 상담 한 줄(leadRows)·등록 확정이 같은 SELECT 를 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 상담 단계 진단 점수 (DQ1 대표 답변 2026-09-25 「점수만 저장 + 담당자가 선택」 · A-04 · v2 §23 · N-53).
 *
 * - 쓰기는 **append-only** 한 줄 + LOG 가 한 트랜잭션이다. 가장 최근 줄이 지금 값이고 지난 줄은 고치지 않는다.
 * - 레벨·교재는 **담당자가 보낸 값 그대로**다. 서버는 점수로 레벨을 정하거나 교재를 제안하지 않는다(A-04/A-05 「자동」은 의도적 제외).
 * - 등록되면 새 칸을 채우지 않는다 — `lead.student_id` 가 이미 그 학생을 가리키므로 학생 쪽 읽기는 그 연결을 따라간다
 *   (`latestLeadDiagForStudent`). 값을 강사 진단 리포트(DIAG)로 옮겨 적지 않는다(두 곳이면 어긋난다 · D-R22).
 * - 한 줄의 모양(SELECT·매핑)은 여기 하나다 — `GET /ops` 카드의 `latestDiag` · 이력 · 등록 결과가 같은 칸을 읽는다.
 */
import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LEAD_DIAG_LEVELS, LEAD_DIAG_LEVEL_LABEL, leadDiagLevelLabel } from '../../lib/lead-diag-words';
import { kstAt } from '../../lib/sql';
import type { LeadDiagDto, LeadDiagListDto, LeadDiagWriteDto } from './lead-diag.dto';

type R = Record<string, unknown>;

/** 진단 한 줄의 칸 — 별칭 `d`(lead_diag) · `b`(lib) · `w`(staff). 이름은 전부 `diag_` 로 시작한다(상담 한 줄에 섞여도 겹치지 않게) */
const LEAD_DIAG_SELECT = `d.id AS diag_id, d.lead_id AS diag_lead_id, d.english AS diag_english, d.math AS diag_math, d.interview AS diag_interview,
       to_char(d.taken_on,'YYYY-MM-DD') AS diag_taken_on, d.level AS diag_level, d.book_id AS diag_book_id, b.title AS diag_book_title,
       d.note AS diag_note, d.created_by AS diag_by_id, w.name AS diag_by_name, ${kstAt('d.created_at')} AS diag_at`;
const LEAD_DIAG_FROM = `lead_diag d LEFT JOIN lib b ON b.id = d.book_id LEFT JOIN staff w ON w.id = d.created_by`;

/**
 * 상담 한 줄(`FROM lead l`)에 **최신 진단 한 줄**을 붙이는 LATERAL — 카드가 따로 묻지 않는다(왕복 0 · D-R37).
 * 붙인 칸은 `ld.*` 로 꺼내 `leadDiagFromRow` 에 넘긴다.
 */
export const LEAD_DIAG_LATEST_JOIN = `LEFT JOIN LATERAL (
         SELECT ${LEAD_DIAG_SELECT} FROM ${LEAD_DIAG_FROM} WHERE d.lead_id = l.id ORDER BY d.id DESC LIMIT 1
       ) ld ON true`;

/** pg bigint 문자열 → 안전 정수. 오염된 연결은 조용히 0/NaN 으로 두지 않는다 (ops.service `leadId` 와 같은 규약) */
function toId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new InternalServerErrorException('상담 데이터 무결성 오류');
  return id;
}
const optId = (value: unknown): number | null => (value == null ? null : toId(value));
const optInt = (value: unknown): number | null => (value == null ? null : Number(value));

/** `diag_*` 칸 → 진단 한 줄. 붙은 줄이 없으면(LATERAL 이 비었거나 칸이 없으면) null */
export function leadDiagFromRow(r: R): LeadDiagDto | null {
  if (r.diag_id == null) return null;
  const level = (r.diag_level as string | null) ?? null;
  return {
    id: toId(r.diag_id), leadId: toId(r.diag_lead_id),
    english: optInt(r.diag_english), math: optInt(r.diag_math), interview: optInt(r.diag_interview),
    takenOn: (r.diag_taken_on as string | null) ?? null,
    level, levelLabel: leadDiagLevelLabel(level),
    bookId: optId(r.diag_book_id), bookTitle: (r.diag_book_title as string | null) ?? null,
    note: (r.diag_note as string | null) ?? null,
    byId: toId(r.diag_by_id), byName: (r.diag_by_name as string | null) ?? null,
    at: String(r.diag_at),
  };
}

/**
 * 학생의 최신 상담 진단 — **`lead.student_id` 를 따라** 읽는다(등록 확정이 그 칸을 채운다).
 * 형제·재등록으로 한 학생에 상담 건이 여럿이면 그중 가장 최근 줄이다.
 */
export async function latestLeadDiagForStudent(m: EntityManager | DataSource, studentId: number): Promise<LeadDiagDto | null> {
  const [row] = (await m.query(
    `SELECT ${LEAD_DIAG_SELECT} FROM ${LEAD_DIAG_FROM} JOIN lead l ON l.id = d.lead_id
      WHERE l.student_id = $1 ORDER BY d.id DESC LIMIT 1`,
    [studentId],
  )) as R[];
  return row ? leadDiagFromRow(row) : null;
}

/** 담당자가 고른 교재 — 상담 건의 **최신 줄**의 것만(지난 줄의 교재를 끌어오지 않는다 · 최신 줄이 지금 값이다) */
export async function latestLeadDiagBookId(m: EntityManager, leadId: number): Promise<number | null> {
  const [row] = (await m.query(`SELECT book_id FROM lead_diag WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`, [leadId])) as R[];
  return row ? optId(row.book_id) : null;
}

const LEVEL_WORDS = LEAD_DIAG_LEVELS.map((key) => ({ key, label: LEAD_DIAG_LEVEL_LABEL[key] }));

@Injectable()
export class LeadDiagService {
  constructor(private readonly ds: DataSource) {}

  /** 이력 — 최근 것이 앞. 레벨 낱말을 함께 준다(화면이 제 표를 들지 않는다 · D-R18) */
  async history(leadId: number, m: EntityManager | DataSource = this.ds): Promise<LeadDiagListDto> {
    const [lead] = (await m.query(`SELECT id, student_id FROM lead WHERE id = $1`, [leadId])) as R[];
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    const rows = (await m.query(
      `SELECT ${LEAD_DIAG_SELECT} FROM ${LEAD_DIAG_FROM} WHERE d.lead_id = $1 ORDER BY d.id DESC`, [leadId],
    )) as R[];
    return {
      leadId, studentId: optId(lead.student_id),
      items: rows.map((r) => leadDiagFromRow(r)).filter((x): x is LeadDiagDto => x !== null),
      levels: LEVEL_WORDS,
    };
  }

  /**
   * 한 줄 적기 — 보낸 칸만 그 줄에 들어간다. 점수·레벨·교재 중 하나는 있어야 한다.
   * 상담 건은 잠그지 않고 FK 잠금(KEY SHARE)만 잡는다 — 단계 이동과 동시에 적어도 서로 막지 않는다.
   * 끝난 건(등록·등록 실패)에도 적는다 — 접촉 원장과 같은 규약이고, 등록 뒤 줄은 그 학생의 것으로 읽힌다.
   */
  async append(userId: number, leadId: number, dto: LeadDiagWriteDto): Promise<LeadDiagListDto> {
    const english = dto.english ?? null;
    const math = dto.math ?? null;
    const interview = dto.interview ?? null;
    const level = dto.level ?? null;
    const bookId = dto.bookId ?? null;
    if ([english, math, interview, level, bookId].every((v) => v === null)) {
      throw new BadRequestException({ code: 'LEAD_DIAG_EMPTY', message: '영어·수학·인터뷰 점수나 레벨·교재 중 하나는 적어 주세요' });
    }
    const note = dto.note?.trim() || null;
    return this.ds.transaction(async (m) => {
      const [lead] = (await m.query(`SELECT id FROM lead WHERE id = $1 FOR KEY SHARE`, [leadId])) as R[];
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
      if (bookId !== null) {
        const [lib] = (await m.query(`SELECT id FROM lib WHERE id = $1 FOR KEY SHARE`, [bookId])) as R[];
        if (!lib) throw new NotFoundException({ code: 'BOOK_NOT_FOUND', message: '고른 교재를 찾을 수 없습니다 — 교재 목록을 다시 불러와 골라 주세요' });
      }
      const [made] = (await m.query(
        `INSERT INTO lead_diag (lead_id, english, math, interview, taken_on, level, book_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9) RETURNING id`,
        [leadId, english, math, interview, dto.takenOn ?? null, level, bookId, note, userId],
      )) as R[];
      // 메모는 LOG 에 싣지 않는다 — 자유 글이라 학부모 연락처가 섞일 수 있다. 적었는지만 남긴다
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'diag','{}'::jsonb,$3::jsonb)`,
        [userId, leadId, JSON.stringify({ diagId: toId(made.id), english, math, interview, takenOn: dto.takenOn ?? null, level, bookId, hasNote: note !== null })],
      );
      return this.history(leadId, m);
    });
  }
}
