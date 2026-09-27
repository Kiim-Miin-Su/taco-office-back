/** @file-guide
 * 목적: books.service.ts — BooksService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { HIST_ACTIONS, histLabel, histSql } from '../../lib/history';
import { todayKst } from '../../lib/kst';
import { NOTI_TITLE } from '../../lib/noti';
import { kstAt, serStuOn } from '../../lib/sql';
import {
  BOOK_EXAM_TAG_LABEL, BOOK_EXAM_TAGS, BOOK_GRADES, BOOK_LEVELS, BOOK_UNCLASSIFIED,
  ISSUE_FORM_LABEL, ISSUE_FORMS, ISSUE_STATE_LABEL, issueFormLabel, PACK_STATE_LABEL, PACK_TYPE_LABEL, bookExamTagLabel, bookGradeCovers, bookGradeFromKey, bookGradeKey,
  bookGradeRangeIssue, bookGradeRangeLabel, bookLevelLabel, bookLevelShown, issueTransitionIssue, packTransitionIssue,
  progressIssue, progressPercent, type IssueState, type PackState, type PackType,
} from '../../lib/book';
import type {
  BookHistoryDto, BookHistoryQueryDto, BookHistoryRowDto, BookIssueCreateDto, BookIssueDiagDto, BookIssueDto,
  BookPackDto, BookPackPatchDto, BookPacksDto, BookPackWriteDto,
  BookPatchDto, BookShelfQueryDto, BookTrackingDto, BookVersionCreateDto, BookVersionDto, BooksDto, BookWriteDto,
} from './books.dto';
import { latestLeadDiagForStudent } from '../ops/lead-diag.service';
import { prepareFile, storePreparedFile } from '../files/files.service';
import { FILE_MAX_BYTES } from '../files/files.dto';
import { canCeoReceivePack, hasPerm, isRole } from '../../common/perm';
import { audit } from '../../lib/audit';

type R = Record<string, unknown>;

const optText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** pg date가 문자열/Date 어느 모양으로 와도 업무 비교는 YYYY-MM-DD 하나만 쓴다. */
function dbDay(value: unknown): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  /* node-postgres는 DATE를 실행 프로세스의 자정 Date로 만든다. ISO 변환은 KST에서 전날로 밀리므로
     날짜 전용 컬럼은 현지 달력 성분을 그대로 조립한다. */
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** 지워진 이력 대상의 낱말 — 「지워진 배부 #23」 (g4 §40-2). 칩 낱말(HIST_ACTIONS)과는 다른 축이다 */
const HIST_ENTITY_WORD: Record<string, string> = { issue: '배부', lib: '교재', vers: '판', guide: '안내' };

function historyRange(span: BookHistoryQueryDto['span'], anchor: string): [string | null, string | null] {
  if (span === 'all') return [null, null];
  if (span === 'day') return [anchor, addDays(anchor, 1)];
  if (span === 'week') {
    const dow = new Date(`${anchor}T00:00:00Z`).getUTCDay();
    const from = addDays(anchor, -(dow === 0 ? 6 : dow - 1));
    return [from, addDays(from, 7)];
  }
  const from = `${anchor.slice(0, 7)}-01`;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return [from, d.toISOString().slice(0, 10)];
}

/**
 * 자료 전달(§41)을 보는 사람 — 요청 사용자(`RequestUser`)가 그대로 들어온다.
 * 「수령 확인」은 누가 보느냐에 따라 열리므로(N-88) id 만으로는 모자라 역할까지 받는다.
 */
export interface PackViewer { id: number; role: string }

/**
 * §41 「수령 확인」을 이 사람이 누를 수 있는가 — **판정은 여기 한 곳**이다(N-88 채택 · W11).
 * 전달된 묶음이고 받을 코디네이터가 정해져 있을 때, 그 코디네이터 **또는 대표 판정**(`canCeoReceivePack`)이면 된다.
 * 응답의 `canReceive`(단추가 서는가)와 쓰기 가드(`PACK_RECEIVER_ONLY`)가 같은 함수를 부른다 — 단추와 서버가 갈리지 않는다.
 */
function packReceiveAllowed(state: string, coordinatorId: unknown, viewer: PackViewer): boolean {
  if (state !== 'delivered' || coordinatorId == null) return false;
  return Number(coordinatorId) === viewer.id || (isRole(viewer.role) && canCeoReceivePack(viewer.role));
}

@Injectable()
export class BooksService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /**
   * §39 서가. 필터(과목 · 레벨 · 학년)는 **서버가 건다** — 화면은 고른 칩의 키만 보낸다(N-47 · D-R37).
   * 칩의 건수 · 경고 띠는 **서가 전체** 기준이다 — 칩을 골라도 다른 칩의 수와 띠가 흔들리지 않는다(§40 칩과 같은 규약).
   * 차례는 과목 → 소분류 → 코드(원문 §39 묶음 · 카드 차례). 과목이 없는 교재(「미분류」)는 맨 뒤에 모인다.
   */
  async all(filter: BookShelfQueryDto = {}): Promise<BooksDto> {
    /*
     * 「지금 쓰는 판」은 **시작일이 오늘 이하인 것 중 가장 나중 것**이다.
     * 「가장 나중 판」은 시작일과 상관없이 제일 나중 것 — 둘이 다르면 아직 시작 안 한 판이 있다는 뜻이고,
     * 그게 원본 §39 의 ⇧ 배지와 「더 최신 판이 있는 교재 N종」 띠다.
     * **비교를 여기서 한 번만 한다** — 화면이 두 낱말을 다시 비교하면 배지와 띠가 갈린다 (D-R39).
     */
    // 차례대로 묻는다 — 한 연결(바깥 트랜잭션)에서 동시에 묻는 것은 pg 가 없애 가는 사용법이다(DeprecationWarning)
    const rows = await this.q(
      `SELECT l.id, l.code, l.title, l.sub_key, l.level, l.grade, l.pages, l.se_te, s.name AS sub_name,
              l.book_subject_key, bs.name AS book_subject_name, bs.color AS book_subject_color,
              l.book_category_key, bc.name AS book_category_name,
              l.book_level, l.grade_from, l.grade_to, l.exam_tag,
              cur.id AS vers_id, cur.edition, cur.file_url, cur.se_file_id, cur.te_file_id,
              top.edition AS latest_edition, top.id AS latest_vers_id,
              (SELECT count(*)::int FROM issue i WHERE i.lib_id = l.id) AS issue_count
         FROM lib l
         LEFT JOIN sub s ON s.key = l.sub_key
         LEFT JOIN book_subject bs ON bs.key = l.book_subject_key
         LEFT JOIN book_category bc ON bc.key = l.book_category_key
         LEFT JOIN LATERAL (
           SELECT v.id, v.edition, v.file_url, v.se_file_id, v.te_file_id FROM vers v
            WHERE v.lib_id = l.id AND (v.from_date IS NULL OR v.from_date <= $1::date)
            ORDER BY v.from_date DESC NULLS LAST, v.activated_at DESC, v.id DESC LIMIT 1) cur ON true
         LEFT JOIN LATERAL (
           SELECT v.id, v.edition FROM vers v
            WHERE v.lib_id = l.id
            ORDER BY v.from_date DESC NULLS LAST, v.id DESC LIMIT 1) top ON true
        ORDER BY bs.sort NULLS LAST, bc.sort NULLS LAST, l.code`,
      [todayKst()],
    );
    const subjectRows = await this.q(`SELECT key, name, color FROM book_subject ORDER BY sort, key`);
    const categoryRows = await this.q(`SELECT key, subject_key, name FROM book_category ORDER BY sort, key`);

    const bySub: Record<string, number> = {};
    for (const r of rows) {
      const k = (r.sub_name as string) ?? BOOK_UNCLASSIFIED.label;
      bySub[k] = (bySub[k] ?? 0) + 1;
    }

    const items = rows.map((r) => {
      const edition = (r.edition as string) ?? null;
      const latest = (r.latest_edition as string) ?? null;
      const gradeFrom = optNum(r.grade_from);
      const gradeTo = optNum(r.grade_to);
      return {
        id: Number(r.id), code: String(r.code), title: String(r.title),
        subKey: (r.sub_key as string) ?? null, subName: (r.sub_name as string) ?? null,
        level: (r.level as string) ?? null, grade: (r.grade as string) ?? null,
        pages: r.pages === null || r.pages === undefined ? null : Number(r.pages),
        seTe: (r.se_te as string) ?? null,
        edition, latestEdition: latest,
        // 판이 하나도 없으면 「더 나중 판」도 없다 — null 끼리 비교해 true 가 되면 안 된다
        hasNewer: latest !== null && edition !== latest,
        versId: r.vers_id === null || r.vers_id === undefined ? null : Number(r.vers_id),
        latestVersId: r.latest_vers_id === null || r.latest_vers_id === undefined ? null : Number(r.latest_vers_id),
        seFileId: r.se_file_id === null || r.se_file_id === undefined ? null : Number(r.se_file_id),
        teFileId: r.te_file_id === null || r.te_file_id === undefined ? null : Number(r.te_file_id),
        hasFile: r.file_url !== null && r.file_url !== undefined || r.se_file_id != null || r.te_file_id != null,
        issueCount: Number(r.issue_count ?? 0),
        // §39 두 층 분류(N-47) — 새 칸이 비었으면 보여 주는 낱말은 옛 원문 그대로다(N-25 · 짐작해 바꾸지 않는다)
        bookSubjectKey: optText(r.book_subject_key), bookSubjectName: optText(r.book_subject_name),
        bookSubjectColor: r.book_subject_color == null ? null : String(r.book_subject_color).trim(),
        bookCategoryKey: optText(r.book_category_key), bookCategoryName: optText(r.book_category_name),
        bookLevel: optText(r.book_level), levelLabel: bookLevelShown(optText(r.book_level), optText(r.level)),
        gradeFrom, gradeTo,
        gradeLabel: bookGradeRangeLabel(gradeFrom, gradeTo) ?? (optText(r.grade)?.trim() || null),
        examTag: optText(r.exam_tag), examTagLabel: bookExamTagLabel(optText(r.exam_tag)),
      };
    });

    // 거르기 — 칩 건수와 **같은 판정**(과목 키 · 레벨 키 · 범위가 학년을 덮는가)으로 고른다
    const gradeWanted = filter.grade ? bookGradeFromKey(filter.grade) : null;
    const shown = items.filter((item) =>
      (!filter.subject
        || (filter.subject === BOOK_UNCLASSIFIED.key ? item.bookSubjectKey === null : item.bookSubjectKey === filter.subject))
      && (!filter.level || item.bookLevel === filter.level)
      && (gradeWanted === null || bookGradeCovers(item.gradeFrom, item.gradeTo, gradeWanted)));

    return {
      bySub,
      items: shown,
      newerCount: items.filter((i) => i.hasNewer).length,
      // 원본 §39의 경고는 일반 파일이 아니라 교사용 TE 파일 누락을 센다.
      noFileCount: items.filter((i) => i.teFileId === null).length,
      newerBooks: items.filter((i) => i.hasNewer)
        .map((i) => ({ id: i.id, title: i.title, edition: i.edition, latestEdition: i.latestEdition })),
      noTeBooks: items.filter((i) => i.teFileId === null).map((i) => ({ id: i.id, title: i.title })),
      levels: [...new Set(items.map((i) => i.level).filter((x): x is string => Boolean(x)))].sort(),
      grades: [...new Set(items.map((i) => i.grade).filter((x): x is string => Boolean(x)))].sort(),
      // 칩은 코드표 전부를 0 까지 준다 — 원문 §39 는 0 인 K · G1 도 흐리게 세워 둔다
      subjects: subjectRows.map((sb) => ({
        key: String(sb.key), label: String(sb.name), color: String(sb.color).trim(),
        count: items.filter((i) => i.bookSubjectKey === String(sb.key)).length,
        categories: categoryRows.filter((c) => String(c.subject_key) === String(sb.key))
          .map((c) => ({ key: String(c.key), label: String(c.name) })),
      })),
      unclassified: { ...BOOK_UNCLASSIFIED, count: items.filter((i) => i.bookSubjectKey === null).length },
      levelCounts: BOOK_LEVELS.map((key) => ({
        key, label: bookLevelLabel(key) ?? key, count: items.filter((i) => i.bookLevel === key).length,
      })),
      gradeCounts: BOOK_GRADES.map((grade) => ({
        key: bookGradeKey(grade), label: bookGradeKey(grade), grade,
        count: items.filter((i) => bookGradeCovers(i.gradeFrom, i.gradeTo, grade)).length,
      })),
      examTags: BOOK_EXAM_TAGS.map((key) => ({ key, label: BOOK_EXAM_TAG_LABEL[key] })),
      versionUploadMaxBytes: FILE_MAX_BYTES,
    };
  }

  /**
   * §39 두 층 분류 검사 — 과목이 코드표에 있고 소분류가 **그 과목의 것**인가 (N-47).
   * 표의 두 칸 FK · `lib_book_category_needs_subject` 와 같은 규칙을 쓰기 전에 말로 돌려준다(FK 오류 500 대신 400).
   */
  private async assertTaxonomy(m: EntityManager, subjectKey: string | null, categoryKey: string | null): Promise<void> {
    if (categoryKey !== null && subjectKey === null) {
      throw new BadRequestException({ code: 'BOOK_CATEGORY_NEEDS_SUBJECT', message: '소분류는 과목을 고른 뒤에 고릅니다' });
    }
    if (subjectKey !== null) {
      const [subject] = await m.query(`SELECT key FROM book_subject WHERE key = $1`, [subjectKey]) as R[];
      if (!subject) throw new BadRequestException({ code: 'BOOK_TAXONOMY_NOT_FOUND', message: '교재 과목을 찾을 수 없습니다' });
    }
    if (categoryKey !== null) {
      const [category] = await m.query(`SELECT subject_key FROM book_category WHERE key = $1`, [categoryKey]) as R[];
      if (!category) throw new BadRequestException({ code: 'BOOK_TAXONOMY_NOT_FOUND', message: '소분류를 찾을 수 없습니다' });
      if (String(category.subject_key) !== subjectKey) {
        throw new BadRequestException({ code: 'BOOK_CATEGORY_MISMATCH', message: '고른 과목의 소분류가 아닙니다' });
      }
    }
  }

  /**
   * 교재 등록 — §39 두 층 분류(N-47)와 **첫 판 · SE/TE 파일(N-61 ① 채택 · W11)**까지 한 트랜잭션이다.
   * 파일은 FILE 표(bytea)라 교재 · 판 · 이력과 함께 커밋되고, 어디서든 실패하면 교재 행도 남지 않는다(고아 LIB/VERS 없음).
   * 첫 판의 이름은 사람이 적은 것만 쓴다 — 없으면 판 없이 교재만 등록한다(원문이 주지 않은 이름을 짓지 않는다).
   */
  async createBook(userId: number, dto: BookWriteDto) {
    const code = dto.code.trim(); const title = dto.title.trim();
    if (!code || !title) throw new BadRequestException({ code: 'BOOK_TEXT_REQUIRED', message: '교재 코드와 이름을 입력해 주세요' });
    const gradeWhy = bookGradeRangeIssue(dto.gradeFrom ?? null, dto.gradeTo ?? null);
    if (gradeWhy) throw new BadRequestException({ code: 'BOOK_GRADE_RANGE', message: gradeWhy });
    try {
      return await this.anyRepo.manager.transaction(async (m) => {
        if (dto.subKey) {
          const [subject] = await m.query(`SELECT key FROM sub WHERE key = $1`, [dto.subKey]);
          if (!subject) throw new BadRequestException({ code: 'BOOK_SUBJECT_NOT_FOUND', message: '과목을 찾을 수 없습니다' });
        }
        await this.assertTaxonomy(m, dto.bookSubjectKey ?? null, dto.bookCategoryKey ?? null);
        const dup = await m.query(`SELECT id FROM lib WHERE code = $1`, [code]);
        if (dup.length) throw new ConflictException({ code: 'BOOK_CODE_DUPLICATE', message: '이미 쓰는 교재 코드입니다' });
        const [row] = await m.query(
          `INSERT INTO lib (code,title,sub_key,level,grade,pages,
                            book_subject_key,book_category_key,book_level,grade_from,grade_to,exam_tag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id,code,title`,
          [code, title, dto.subKey ?? null, dto.level ?? null, dto.grade ?? null, dto.pages ?? null,
           dto.bookSubjectKey ?? null, dto.bookCategoryKey ?? null, dto.bookLevel ?? null,
           dto.gradeFrom ?? null, dto.gradeTo ?? null, dto.examTag ?? null],
        ) as R[];
        await m.query(histSql(), ['lib', Number(row.id), 'book_upload', userId]);
        // N-61 — 첫 판은 「+ 판 올리기」와 같은 몸통(파일 종류 · 합계 크기 · 같은 이름 검사 · 이력)을 같은 트랜잭션에서 부른다
        if (dto.firstVersion) await this.addVersionWithin(m, userId, Number(row.id), dto.firstVersion);
        return { id: Number(row.id), code: String(row.code), title: String(row.title) };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'BOOK_CODE_DUPLICATE', message: '이미 쓰는 교재 코드입니다' });
      throw e;
    }
  }

  /**
   * 교재 기본 정보 수정 — **고친 사람이 안 남던 자리다** (S7 · 전수 검수 §7).
   *
   * 이 경로는 `@CurrentUser` 를 받지도 않았다. 코드·이름·과목·레벨·학년·쪽수를 바꿔도 누가 언제
   * 무엇을 무엇으로 바꿨는지 어디에도 없었고, **쪽수는 진도 퍼센트의 분모**라 조용히 내려가면
   * §38 트래킹의 모든 줄이 함께 움직인다.
   *
   * **`hist` 가 아니라 `log` 다.** `HIST_ACTIONS` 는 원문 §40 의 필터 칩 목록 그대로라
   * 「교재 정보 수정」이라는 낱말이 없고, 없는 칩을 새로 지으면 그 줄은 「전체」에만 걸린다(D-R44).
   * 게다가 `hist` 에는 before/after 칸이 아예 없어 **무엇이 무엇으로 바뀌었는지**를 담지 못한다.
   * 두 원장은 일이 다르다 — `hist` 는 §40 화면의 낱말, `log` 는 before/after 감사다. 합치지 않는다.
   *
   * 남기는 칸은 **보낸 칸만**이다(PATCH 규약) — 안 보낸 칸까지 적으면 안 바뀐 값이 바뀐 것처럼 읽힌다.
   */
  async patchBook(userId: number, id: number, dto: BookPatchDto) {
    const keys = Object.entries(dto).filter(([, v]) => v !== undefined);
    if (!keys.length) throw new BadRequestException('바꿀 교재 값을 하나 이상 보내 주세요');
    const col: Record<string, string> = {
      code: 'code', title: 'title', subKey: 'sub_key', level: 'level', grade: 'grade', pages: 'pages',
      // §39 두 층 분류(N-47) — 사람이 편집 창에서 분류한다. 보낸 칸만 바뀌고 원장(log)에 앞뒤가 남는다
      bookSubjectKey: 'book_subject_key', bookCategoryKey: 'book_category_key', bookLevel: 'book_level',
      gradeFrom: 'grade_from', gradeTo: 'grade_to', examTag: 'exam_tag',
    };
    const sets = keys.map(([k], n) => `"${col[k]}" = $${n + 2}`).join(', ');
    if (dto.code !== undefined && (typeof dto.code !== 'string' || !dto.code.trim())
      || dto.title !== undefined && (typeof dto.title !== 'string' || !dto.title.trim())) {
      throw new BadRequestException({ code: 'BOOK_TEXT_REQUIRED', message: '교재 코드와 이름은 비울 수 없습니다' });
    }
    try {
      return await this.anyRepo.manager.transaction(async (m) => {
        const [book] = await m.query(`SELECT * FROM lib WHERE id=$1 FOR UPDATE`, [id]) as R[];
        if (!book) throw new NotFoundException('교재를 찾을 수 없습니다');
        if (dto.subKey) {
          const [subject] = await m.query(`SELECT key FROM sub WHERE key = $1`, [dto.subKey]);
          if (!subject) throw new BadRequestException({ code: 'BOOK_SUBJECT_NOT_FOUND', message: '과목을 찾을 수 없습니다' });
        }
        /*
         * 분류는 **고친 뒤의 모양**으로 본다 — 보낸 칸은 새 값, 안 보낸 칸은 지금 값. 과목만 바꾸고 옛 소분류가 남으면
         * 다른 과목의 소분류가 되므로 거절한다(편집 창은 둘을 함께 보낸다). 학년 범위도 두 칸을 합쳐 본다.
         */
        const after = (field: keyof BookPatchDto, column: string): unknown => (dto[field] !== undefined ? dto[field] : book[column]);
        if (dto.bookSubjectKey !== undefined || dto.bookCategoryKey !== undefined) {
          await this.assertTaxonomy(m, optText(after('bookSubjectKey', 'book_subject_key')), optText(after('bookCategoryKey', 'book_category_key')));
        }
        if (dto.gradeFrom !== undefined || dto.gradeTo !== undefined) {
          const why = bookGradeRangeIssue(optNum(after('gradeFrom', 'grade_from')), optNum(after('gradeTo', 'grade_to')));
          if (why) throw new BadRequestException({ code: 'BOOK_GRADE_RANGE', message: why });
        }
        // 전체 쪽수 미정(null)은 0쪽이 아니다. 진도 쪽수는 보존하고 비율만 null로 파생한다.
        if (dto.pages != null) {
          const [progress] = await m.query(
            `SELECT max(progress_page)::int AS max_page FROM issue WHERE lib_id=$1`, [id],
          ) as Array<{ max_page: number | null }>;
          if (progress.max_page !== null && Number(progress.max_page) > dto.pages) {
            throw new ConflictException({
              code: 'BOOK_PAGES_BELOW_PROGRESS',
              message: `교재 쪽수는 기록된 최대 진도 ${progress.max_page}쪽보다 작을 수 없습니다`,
            });
          }
        }
        const next = keys.map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v] as const);
        const rows = await m.query(`UPDATE lib SET ${sets} WHERE id = $1 RETURNING id,code,title`, [id, ...next.map(([, v]) => v)]);
        await m.query(
          `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LIB',$2,'edit',$3::jsonb,$4::jsonb)`,
          [userId, id,
            JSON.stringify(Object.fromEntries(next.map(([k]) => [k, book[col[k]] ?? null]))),
            JSON.stringify(Object.fromEntries(next))],
        );
        return { id: Number(rows[0].id), code: String(rows[0].code), title: String(rows[0].title) };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'BOOK_CODE_DUPLICATE', message: '이미 쓰는 교재 코드입니다' });
      throw e;
    }
  }

  /* ══ §39 판(VERS) 올리기 · 바꾸기 (C52) ═══════════════════════════════════ */

  /**
   * 새 판을 올린다. **이력이 같은 트랜잭션에서 함께 남는다** —
   * 밖에서 남기면 쓰기는 되돌아가고 이력만 남아 「하지도 않은 일」이 장부에 찍힌다.
   *
   * 같은 교재에 같은 판 이름은 둘일 수 없다. 배지에 같은 글자가 둘이면
   * 어느 것을 보고 있는지 화면이 말할 수 없다.
   */
  async addVersion(userId: number, libId: number, dto: BookVersionCreateDto): Promise<BookVersionDto> {
    try {
      return await this.anyRepo.manager.transaction((m: EntityManager) => this.addVersionWithin(m, userId, libId, dto));
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'VERS_DUPLICATE', message: `이 교재에 「${dto.edition}」 판은 이미 있습니다` });
      }
      throw error;
    }
  }

  /**
   * 바깥 트랜잭션 안에서 판 하나 — 「+ 판 올리기」와 교재 등록의 첫 판(N-61)이 **같은 몸통**을 쓴다
   * (`createIssueWithin` 과 같은 …Within 모양). 파일 검사(종류 · 합계 크기)도 여기 한 곳이다.
   */
  private async addVersionWithin(m: EntityManager, userId: number, libId: number, dto: BookVersionCreateDto): Promise<BookVersionDto> {
    const today = todayKst();
    {
      const [lib] = (await m.query(`SELECT id, title FROM lib WHERE id = $1 FOR UPDATE`, [libId])) as Array<{ id: string }>;
      if (!lib) throw new NotFoundException('교재를 찾을 수 없습니다');

      if ((dto.seFile && dto.seFile.kind !== 'lib-se') || (dto.teFile && dto.teFile.kind !== 'lib-te')) {
        throw new BadRequestException({ code: 'BOOK_FILE_KIND_MISMATCH', message: 'SE/TE 파일 종류와 연결 위치가 일치하지 않습니다' });
      }

      const sePrepared = dto.seFile ? prepareFile(dto.seFile) : null;
      const tePrepared = dto.teFile ? prepareFile(dto.teFile) : null;
      if ((sePrepared?.bytes.length ?? 0) + (tePrepared?.bytes.length ?? 0) > FILE_MAX_BYTES) {
        throw new PayloadTooLargeException({ code: 'BOOK_FILES_TOO_LARGE', message: '한 판의 SE·TE 파일 합계는 3MB까지 올릴 수 있습니다' });
      }
      const seUploaded = dto.seFile && sePrepared ? await storePreparedFile(m, userId, dto.seFile, sePrepared) : null;
      const teUploaded = dto.teFile && tePrepared ? await storePreparedFile(m, userId, dto.teFile, tePrepared) : null;
      const seFileId = seUploaded?.id;
      const teFileId = teUploaded?.id;

      const dup = (await m.query(
        `SELECT id FROM vers WHERE lib_id = $1 AND edition = $2`, [libId, dto.edition],
      )) as Array<{ id: string }>;
      if (dup.length > 0) {
        throw new ConflictException({
          code: 'VERS_DUPLICATE',
          message: `이 교재에 「${dto.edition}」 판은 이미 있습니다`,
        });
      }

      const [made] = (await m.query(
        `INSERT INTO vers (lib_id, edition, file_url, from_date, se_file_id, te_file_id)
         VALUES ($1, $2, $3, $4::date, $5, $6)
         RETURNING id, lib_id, edition, file_url, se_file_id, te_file_id, to_char(from_date,'YYYY-MM-DD') AS from_date`,
        [libId, dto.edition, null, dto.fromDate ?? today, seFileId ?? null, teFileId ?? null],
      )) as Array<R>;
      await m.query(histSql(), ['vers', Number(made.id), 'book_upload', userId]);
      const [current] = await m.query(
        `SELECT id FROM vers WHERE lib_id=$1 AND (from_date IS NULL OR from_date <= $2::date)
          ORDER BY from_date DESC NULLS LAST,activated_at DESC,id DESC LIMIT 1`,
        [libId, today],
      ) as R[];

      return {
        id: Number(made.id), libId: Number(made.lib_id), edition: String(made.edition),
        fileUrl: (made.file_url as string) ?? null,
        seFileId: made.se_file_id == null ? null : Number(made.se_file_id),
        teFileId: made.te_file_id == null ? null : Number(made.te_file_id),
        fromDate: (made.from_date as string) ?? null,
        inUse: Number(current?.id) === Number(made.id),
      };
    }
  }

  /**
   * 「판 버튼을 눌러 바꿉니다」 — **오늘부터 이 판을 쓴다** (원본 §39 머리 띠).
   *
   * 바꾼다는 것이 무엇을 바꾸는지 원문이 낱말로 말하지 않아, 있는 칸으로 가장 곧게 읽었다 —
   * 「지금 쓰는 판」은 `from_date` 가 오늘 이하인 것 중 가장 나중 것이므로, **시작일을 오늘로 당기면**
   * 그 판이 지금 쓰는 판이 된다. 새 칸을 만들지 않았다.
   * (이 읽기가 틀리면 고칠 자리는 이 메서드 하나다 — 원장에 그렇게 적어 두었다.)
   *
   * **이미 쓰고 있는 판은 다시 당기지 않는다** — 이력에 같은 일이 두 번 남는다.
   */
  async useVersion(userId: number, versId: number): Promise<BookVersionDto> {
    const today = todayKst();
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [candidate] = (await m.query(`SELECT lib_id FROM vers WHERE id=$1`, [versId])) as Array<R>;
      if (!candidate) throw new NotFoundException('판을 찾을 수 없습니다');
      await m.query(`SELECT id FROM lib WHERE id=$1 FOR UPDATE`, [candidate.lib_id]);
      const [v] = (await m.query(
        `SELECT id, lib_id, edition, file_url, se_file_id, te_file_id, to_char(from_date,'YYYY-MM-DD') AS from_date
           FROM vers WHERE id = $1 FOR UPDATE`, [versId],
      )) as Array<R>;
      if (!v) throw new NotFoundException('판을 찾을 수 없습니다');

      /* 모든 판 쓰기가 LIB를 먼저 잠근다. 서로 다른 target을 먼저 잡아 생기는 교차 대기를 피한다. */
      await m.query(`SELECT id FROM vers WHERE lib_id=$1 ORDER BY id FOR UPDATE`, [v.lib_id]);
      const [current] = await m.query(
        `SELECT id FROM vers WHERE lib_id=$1 AND (from_date IS NULL OR from_date <= $2::date)
          ORDER BY from_date DESC NULLS LAST,activated_at DESC,id DESC LIMIT 1`,
        [v.lib_id, today],
      ) as R[];
      if (Number(current?.id) === versId) {
        throw new ConflictException({
          code: 'VERS_ALREADY_IN_USE',
          message: `「${String(v.edition)}」 판은 이미 쓰고 있습니다`,
        });
      }

      await m.query(`UPDATE vers SET from_date = $2::date, activated_at = clock_timestamp() WHERE id = $1`, [versId, today]);
      await m.query(histSql(), ['vers', versId, 'book_swap', userId]);

      return {
        id: Number(v.id), libId: Number(v.lib_id), edition: String(v.edition),
        fileUrl: (v.file_url as string) ?? null,
        seFileId: v.se_file_id == null ? null : Number(v.se_file_id),
        teFileId: v.te_file_id == null ? null : Number(v.te_file_id),
        fromDate: today, inUse: true,
      };
    });
  }

  /* ══ §40 교재 이력 — 읽기만 한다 (C52) ════════════════════════════════════ */

  /**
   * 이력 줄. **문장은 읽을 때 만든다** — 쓸 때 굳혀 두면 교재 이름이 바뀌어도
   * 이력만 옛 이름으로 남는다. `hist` 에 설명 칸이 없는 것이 그 설계다.
   */
  async historyBoard(query: BookHistoryQueryDto): Promise<BookHistoryDto> {
    const [from, to] = historyRange(query.span ?? 'month', query.anchor ?? todayKst());
    const lineSql = `SELECT h.id, h.entity, h.ref_id, h.action, ${kstAt('h.at')} AS at,
              st.name AS by_name,
              CASE h.entity
                WHEN 'vers'  THEN (SELECT l.title || ' · ' || v.edition
                                     FROM vers v JOIN lib l ON l.id = v.lib_id WHERE v.id = h.ref_id)
                WHEN 'lib'   THEN (SELECT l.title FROM lib l WHERE l.id = h.ref_id)
                WHEN 'issue' THEN (SELECT s.name || ' · ' || l.title
                                     FROM issue i JOIN lib l ON l.id = i.lib_id
                                     JOIN stu s ON s.id = i.student_id WHERE i.id = h.ref_id)
                WHEN 'guide' THEN (SELECT s.name FROM guide g JOIN stu s ON s.id = g.student_id WHERE g.id = h.ref_id)
                ELSE NULL END AS subject,
              CASE h.entity
                WHEN 'vers' THEN (SELECT l.code FROM vers v JOIN lib l ON l.id=v.lib_id WHERE v.id=h.ref_id)
                WHEN 'lib' THEN (SELECT l.code FROM lib l WHERE l.id=h.ref_id)
                WHEN 'issue' THEN (SELECT l.code FROM issue i JOIN lib l ON l.id=i.lib_id WHERE i.id=h.ref_id)
                WHEN 'guide' THEN (SELECT sr.title FROM guide g LEFT JOIN ser sr ON sr.id=g.ser_id WHERE g.id=h.ref_id)
                ELSE NULL END AS code,
              /* 메모 — 안내는 본문, 배부는 사유(N-62 · 원문 §40 「+ 교재 배부」 줄 끝 글) */
              CASE h.entity
                WHEN 'guide' THEN (SELECT g.body FROM guide g WHERE g.id=h.ref_id)
                WHEN 'issue' THEN CASE WHEN h.action='book_issue' THEN (SELECT i.reason FROM issue i WHERE i.id=h.ref_id) END
                END AS memo,
              /* 가리키던 행이 아직 있는가 — hist 에는 FK 가 없어 대상이 지워져도 줄은 남는다(지워지지 않는 원장) */
              CASE h.entity
                WHEN 'vers'  THEN EXISTS (SELECT 1 FROM vers v WHERE v.id=h.ref_id)
                WHEN 'lib'   THEN EXISTS (SELECT 1 FROM lib l WHERE l.id=h.ref_id)
                WHEN 'issue' THEN EXISTS (SELECT 1 FROM issue i WHERE i.id=h.ref_id)
                WHEN 'guide' THEN EXISTS (SELECT 1 FROM guide g WHERE g.id=h.ref_id)
                ELSE true END AS ref_exists,
              CASE h.entity
                WHEN 'issue' THEN (SELECT t.name FROM issue i JOIN stu s ON s.id=i.student_id JOIN ser_stu ss ON ss.student_id=s.id JOIN ser sr ON sr.id=ss.ser_id JOIN staff t ON t.id=sr.teacher_id WHERE i.id=h.ref_id ORDER BY sr.id LIMIT 1)
                WHEN 'guide' THEN (SELECT t.name FROM guide g LEFT JOIN staff t ON t.id=g.teacher_id WHERE g.id=h.ref_id)
                ELSE NULL END AS teacher_name,
              CASE h.entity WHEN 'issue' THEN (SELECT i.student_id FROM issue i WHERE i.id=h.ref_id) WHEN 'guide' THEN (SELECT g.student_id FROM guide g WHERE g.id=h.ref_id) END AS student_id,
              CASE h.entity WHEN 'issue' THEN (SELECT s.name FROM issue i JOIN stu s ON s.id=i.student_id WHERE i.id=h.ref_id) WHEN 'guide' THEN (SELECT s.name FROM guide g JOIN stu s ON s.id=g.student_id WHERE g.id=h.ref_id) END AS student_name
         FROM hist h
         LEFT JOIN staff st ON st.id = h.by_id
        WHERE ($1::date IS NULL OR h.at >= $1::date)
          AND ($2::date IS NULL OR h.at < $2::date)`;
    const searchSql = `($3::text IS NULL OR subject ILIKE '%' || $3 || '%' OR by_name ILIKE '%' || $3 || '%' OR teacher_name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')`;
    const args = [from, to, query.q?.trim() || null, query.action ?? null, query.studentId ?? null];
    const [rows, facetRows] = await Promise.all([
      this.q(
        `WITH lines AS (${lineSql}) SELECT * FROM lines
          WHERE ${searchSql}
            AND ($4::text IS NULL OR action=$4)
            AND ($5::bigint IS NULL OR student_id=$5)
          ORDER BY at DESC,id DESC LIMIT 500`,
        args,
      ),
      this.q(
        `WITH lines AS (${lineSql}) SELECT action,student_id,student_name FROM lines WHERE ${searchSql}`,
        args.slice(0, 3),
      ),
    ]);
    // 유형/학생 facet은 선택해도 사라지지 않아야 한다. 기간·검색 결과를 기준으로 facet을 만들고
    // 선택 조건은 목록에만 적용한다 — 원본 §40의 9개 고정 필터와 학생 레일을 보존한다.
    const items = rows.map((r) => ({
      id: Number(r.id), action: String(r.action), actionLabel: histLabel(String(r.action)),
      entity: String(r.entity), refId: Number(r.ref_id),
      // 지워진 대상은 빈칸(—) 대신 무엇이었는지 적는다 (g4 §40-2) — 문장은 읽을 때 만든다
      subject: r.ref_exists === false
        ? `지워진 ${HIST_ENTITY_WORD[String(r.entity)] ?? '항목'} #${Number(r.ref_id)}`
        : (r.subject as string) ?? null,
      refMissing: r.ref_exists === false,
      code: (r.code as string) ?? null, memo: (r.memo as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      studentId: r.student_id == null ? null : Number(r.student_id),
      byName: (r.by_name as string) ?? null,
      at: String(r.at),
    }));
    const counts = (values: Array<[string, string]>) => [...values.reduce((m, [key, label]) => {
      const old = m.get(key); m.set(key, { key, label, count: (old?.count ?? 0) + 1 }); return m;
    }, new Map<string, { key: string; label: string; count: number }>()).values()];
    return {
      items,
      actions: HIST_ACTIONS.map((action) => ({
        key: action, label: histLabel(action), count: facetRows.filter((r) => String(r.action) === action).length,
      })),
      byStudent: counts(facetRows.filter((r) => r.student_id != null).map((r) => [String(r.student_id), String(r.student_name)])),
      byDay: counts(rows.map((r) => [String(r.at).slice(0, 10), String(r.at).slice(0, 10)])),
      total: items.length,
      bookCount: rows.filter((r) => ['lib', 'vers', 'issue'].includes(String(r.entity))).length,
      guideCount: rows.filter((r) => ['guide', 'pnoti'].includes(String(r.entity))).length,
    };
  }

  /** C52 직접 서비스 소비와의 호환. HTTP 화면은 집계가 포함된 historyBoard를 쓴다. */
  async history(limit = 200): Promise<BookHistoryRowDto[]> {
    const board = await this.historyBoard({ span: 'all' });
    return board.items.slice(0, limit);
  }

  private issueDto(r: R): BookIssueDto {
    const state = String(r.state) as IssueState;
    const pages = r.pages == null ? null : Number(r.pages);
    const page = r.progress_page == null ? null : Number(r.progress_page);
    return {
      id: Number(r.id), libId: Number(r.lib_id), studentId: Number(r.student_id),
      versId: r.vers_id == null ? null : Number(r.vers_id), state, stateLabel: ISSUE_STATE_LABEL[state],
      edition: (r.edition as string) ?? null,
      fileUrl: (r.file_url as string) ?? null,
      seFileId: r.se_file_id == null ? null : Number(r.se_file_id),
      teFileId: r.te_file_id == null ? null : Number(r.te_file_id),
      issuedOn: r.issued_on == null ? null : dbDay(r.issued_on),
      returnedOn: r.returned_on == null ? null : dbDay(r.returned_on),
      progressPage: page, progressPercent: progressPercent(page, pages),
      reason: optText(r.reason),
      // 형태 칩(§38-2 · W11 A') — 낱말은 서버가 만든다 · 옛 줄 NULL = 칩 없음
      form: optText(r.form), formLabel: issueFormLabel(optText(r.form)),
    };
  }

  async tracking(): Promise<BookTrackingDto> {
    const rows = await this.q(
      `SELECT s.id AS student_id, s.name, s.grade,
              i.id, i.lib_id, i.vers_id, i.state, i.progress_page, i.reason, i.form,
              to_char(i.issued_on,'YYYY-MM-DD') AS issued_on, to_char(i.returned_on,'YYYY-MM-DD') AS returned_on,
              l.title, l.pages, l.level AS lib_level, l.book_level, v.edition, v.file_url, v.se_file_id, v.te_file_id,
              (SELECT st.name FROM ser_stu ss JOIN ser sr ON sr.id=ss.ser_id JOIN staff st ON st.id=sr.teacher_id
                WHERE ss.student_id=s.id ORDER BY sr.id LIMIT 1) AS teacher_name,
              (SELECT to_char(lower(o.span) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI')
                 FROM ser_stu ss JOIN ser_occ o ON o.ser_id=ss.ser_id AND ${serStuOn('ss', 'o.on_date')}
                WHERE ss.student_id=s.id AND o.canceled=false AND lower(o.span) >= now()
                ORDER BY lower(o.span) LIMIT 1) AS next_lesson,
              (SELECT g.state::text FROM guide g WHERE g.student_id=s.id ORDER BY g.id DESC LIMIT 1) AS guide_state
         FROM stu s
         LEFT JOIN issue i ON i.student_id=s.id AND i.state <> 'returned'
         LEFT JOIN lib l ON l.id=i.lib_id
         LEFT JOIN vers v ON v.id=i.vers_id
        ORDER BY s.name, i.id`,
    );
    const students = new Map<number, BookTrackingDto['students'][number]>();
    const guideStateByStudent = new Map<number, string | null>();
    for (const r of rows) {
      const id = Number(r.student_id);
      const row = students.get(id) ?? {
        id, name: String(r.name), grade: (r.grade as string) ?? null,
        teacherName: (r.teacher_name as string) ?? null, nextLesson: (r.next_lesson as string) ?? null,
        issues: [], todos: [], todoLabel: '정상',
      };
      guideStateByStudent.set(id, (r.guide_state as string) ?? null);
      if (r.id != null) row.issues.push(this.issueDto(r));
      row.todoLabel = row.issues.length === 0 ? '교재 없음' : row.issues.some((i) => i.state === 'wait' || i.state === 'auto') ? '확인 필요' : '정상';
      students.set(id, row);
    }
    const active = rows.filter((r) => r.id != null);
    const bookMap = new Map<number, {
      libId: number; title: string; level: string | null; studentCount: number; values: number[]; pages: number | null;
      students: Array<{ studentId: number; name: string; percent: number | null; elapsedDays: number | null }>;
    }>();
    for (const r of active) {
      // level — 「교재별 진도율」 카드의 레벨 배지·왼쪽 띠(원문 §38 · g4 §38-7). 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 LIB 옛 원문
      const libId = Number(r.lib_id); const old = bookMap.get(libId) ?? {
        libId, title: String(r.title), level: bookLevelShown(optText(r.book_level), optText(r.lib_level)), studentCount: 0, values: [],
        pages: r.pages == null ? null : Number(r.pages), students: [],
      };
      old.studentCount += 1;
      const p = progressPercent(r.progress_page == null ? null : Number(r.progress_page), r.pages == null ? null : Number(r.pages));
      if (p !== null) old.values.push(p);
      const issuedOn = r.issued_on == null ? null : String(r.issued_on).slice(0, 10);
      old.students.push({
        studentId: Number(r.student_id), name: String(r.name), percent: p,
        elapsedDays: issuedOn ? Math.max(0, Math.floor((Date.parse(`${todayKst()}T00:00:00Z`) - Date.parse(`${issuedOn}T00:00:00Z`)) / 86_400_000)) : null,
      });
      bookMap.set(libId, old);
    }
    const books = [...bookMap.values()].map(({ values, ...b }) => ({
      ...b, minPercent: values.length ? Math.min(...values) : null,
      maxPercent: values.length ? Math.max(...values) : null,
      averagePercent: values.length ? Math.round(values.reduce((a, n) => a + n, 0) / values.length) : null,
    }));
    const studentRows = [...students.values()];
    const teacherRequests = (await this.q(
      `SELECT r.id, st.name AS requester_name, COALESCE(r.student_id, legacy.student_id) AS student_id,
              COALESCE(s.name, r.payload->>'studentName') AS student_name,
              COALESCE(NULLIF(r.payload->>'message',''), '교재 변경 요청') AS message
         FROM req r JOIN staff st ON st.id=r.staff_id
         LEFT JOIN LATERAL (
           SELECT min(id) AS student_id FROM stu
            WHERE name=r.payload->>'studentName' HAVING count(*)=1
         ) legacy ON r.student_id IS NULL
         LEFT JOIN stu s ON s.id=COALESCE(r.student_id, legacy.student_id)
        WHERE r.req_type='book_change' AND r.state IN ('open','pending')
        ORDER BY r.created_at DESC,r.id DESC`,
    )).map((row) => ({
      id: Number(row.id), requesterName: String(row.requester_name),
      studentId: row.student_id == null ? null : Number(row.student_id),
      studentName: (row.student_name as string) ?? null, message: String(row.message),
    }));
    for (const student of studentRows) {
      const todos: BookTrackingDto['students'][number]['todos'] = [];
      const wait = student.issues.filter((issue) => issue.state === 'wait').length;
      const auto = student.issues.filter((issue) => issue.state === 'auto').length;
      const requested = teacherRequests.filter((request) => request.studentId === student.id).length;
      if (wait) todos.push({ key: 'wait', label: '승인 대기', count: wait });
      // 배부 auto 는 머리 칸과 같은 낱말 「전달 대기」다 — 「안내 발송 대기」는 아래 안내 초안의 뜻이라
      // 한 칩 낱말이 두 뜻이 되지 않게 가른다 (g4 §38-1)
      if (auto) todos.push({ key: 'auto', label: '전달 대기', count: auto });
      if (requested) todos.push({ key: 'teacher_request', label: '강사 요청', count: requested });
      const guideState = guideStateByStudent.get(student.id);
      if (!guideState) todos.push({ key: 'guide_missing', label: '안내 없음', count: 1 });
      else if (guideState === 'draft' || guideState === 'ready') todos.push({ key: 'guide_pending', label: '안내 발송 대기', count: 1 });
      else if (guideState === 'sent') todos.push({ key: 'guide_ack', label: '강사 확인 대기', count: 1 });
      else todos.push({ key: 'guide_done', label: '안내 발송 완료', count: 1 });
      student.todos = todos;
      student.todoLabel = todos.some((todo) => todo.key !== 'guide_done') ? '확인 필요' : '정상';
    }
    const imminent = studentRows.filter((student) =>
      student.nextLesson?.slice(0, 10) === todayKst() && student.todoLabel !== '정상').length;
    const stateKeys: Array<[string, string, number]> = [
      ['students', '학생', studentRows.length],
      ['wait', '승인 대기', studentRows.filter((s) => s.issues.some((i) => i.state === 'wait')).length],
      ['auto', '전달 대기', studentRows.filter((s) => s.issues.some((i) => i.state === 'auto')).length],
      ['imminent', '수업 임박', imminent],
      ['teacher_request', '강사 요청', teacherRequests.length],
      ['ok', '정상', studentRows.filter((s) => s.todoLabel === '정상').length],
    ];
    return {
      students: studentRows,
      books,
      teacherRequests,
      states: stateKeys.map(([key, label, count]) => ({ key, label, count })),
      issueForms: ISSUE_FORMS.map((key) => ({ key, label: ISSUE_FORM_LABEL[key] })),
    };
  }

  /**
   * 배부 창의 진단 한 줄 — 그 학생의 **최신 상담 진단**을 읽기만 한다 (N-62 ① · DQ1).
   * 읽는 함수는 §44 와 같은 한 벌(`latestLeadDiagForStudent`)이다 — 점수를 배부에 옮겨 적지 않는다(D-R22).
   */
  async latestDiag(studentId: number): Promise<BookIssueDiagDto> {
    const [stu] = await this.q(`SELECT id FROM stu WHERE id = $1`, [studentId]);
    if (!stu) throw new NotFoundException('학생을 찾을 수 없습니다');
    return { studentId, diag: await latestLeadDiagForStudent(this.anyRepo.manager, studentId) };
  }

  async createIssue(userId: number, dto: BookIssueCreateDto): Promise<BookIssueDto> {
    return this.anyRepo.manager.transaction(async (m) => this.createIssueWithin(m, userId, dto));
  }

  /** 바깥 트랜잭션 안에서 한 건 — 등록 확정(C91)이 교재 요청(wait)을 같은 트랜잭션에서 남긴다 */
  async createIssueWithin(m: EntityManager, userId: number, dto: BookIssueCreateDto): Promise<BookIssueDto> {
    {
      const [lib] = await m.query(`SELECT id,pages FROM lib WHERE id=$1 FOR UPDATE`, [dto.libId]) as R[];
      if (!lib) throw new NotFoundException('교재를 찾을 수 없습니다');
      const stu = await m.query(`SELECT id FROM stu WHERE id=$1 FOR KEY SHARE`, [dto.studentId]);
      if (!stu.length) throw new NotFoundException('학생을 찾을 수 없습니다');
      if (dto.progressPage !== undefined) {
        const why = progressIssue(dto.progressPage, lib.pages == null ? null : Number(lib.pages));
        if (why) throw new BadRequestException(why);
      }
      const state = (dto.state ?? 'ok') as IssueState;
      const issuedOn = state === 'ok' ? (dto.issuedOn ?? todayKst()) : null;
      /*
       * §38 배부 원장은 클라이언트가 판을 고르지 않는다. 배부가 생성되는 시점의 현재 판을
       * ISSUE.vers_id에 고정해 두어, 나중에 서가의 현재 판이 바뀌어도 이미 배부한 교재의
       * 판·파일이 소급 변경되지 않게 한다. 과거 배부일을 명시한 경우에는 그 날짜의 유효 판을 쓴다.
       */
      const snapshotOn = issuedOn ?? todayKst();
      const [version] = await m.query(
        `SELECT id,edition,file_url,se_file_id,te_file_id FROM vers
          WHERE lib_id=$1 AND (from_date IS NULL OR from_date <= $2::date)
          ORDER BY from_date DESC NULLS LAST,activated_at DESC,id DESC LIMIT 1
          FOR KEY SHARE`,
        [dto.libId, snapshotOn],
      ) as R[];
      // 배부 사유(N-62) — 적은 것만 남긴다. 빈 칸은 NULL 이다(사유를 지어 넣지 않는다)
      const reason = dto.reason?.trim() || null;
      try {
        const [row] = await m.query(
          `INSERT INTO issue (lib_id,vers_id,student_id,issued_on,state,progress_page,requested_by,approved_by,delivered_at,reason,form)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, NULL::int AS pages`,
          [dto.libId, version?.id ?? null, dto.studentId, issuedOn, state, dto.progressPage ?? null,
           userId, state === 'ok' ? userId : null, state === 'ok' ? new Date() : null, reason, dto.form ?? null],
        ) as R[];
        if (state === 'ok') await m.query(histSql(), ['issue', Number(row.id), 'book_issue', userId]);
        return this.issueDto({
          ...row,
          edition: version?.edition ?? null,
          file_url: version?.file_url ?? null,
          se_file_id: version?.se_file_id ?? null,
          te_file_id: version?.te_file_id ?? null,
          pages: lib.pages,
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'BOOK_ALREADY_ACTIVE', message: '이 학생에게 이미 배부 중인 교재입니다' });
        throw e;
      }
    }
  }

  async transitionIssue(userId: number, id: number, target: 'auto' | 'ok'): Promise<BookIssueDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const [r] = await m.query(
        `SELECT i.*,l.pages,v.edition,v.file_url,v.se_file_id,v.te_file_id
           FROM issue i JOIN lib l ON l.id=i.lib_id LEFT JOIN vers v ON v.id=i.vers_id
          WHERE i.id=$1 FOR UPDATE OF i`,
        [id],
      ) as R[];
      if (!r) throw new NotFoundException('배부 내역을 찾을 수 없습니다');
      const why = issueTransitionIssue(String(r.state) as IssueState, target);
      if (why) throw new ConflictException({ code: 'ISSUE_INVALID_TRANSITION', message: why });

      if (target === 'auto') {
        await m.query(`UPDATE issue SET state='auto',approved_by=$2 WHERE id=$1`, [id, userId]);
        return this.issueDto({ ...r, state: 'auto', approved_by: userId });
      }
      const issuedOn = todayKst();
      await m.query(
        `UPDATE issue SET state='ok',issued_on=$2::date,approved_by=COALESCE(approved_by,$3),delivered_at=now()
          WHERE id=$1`,
        [id, issuedOn, userId],
      );
      await m.query(histSql(), ['issue', id, 'book_issue', userId]);
      return this.issueDto({ ...r, state: 'ok', issued_on: issuedOn, approved_by: r.approved_by ?? userId });
    });
  }

  /**
   * 진도 갱신 — **적은 사람이 안 남던 자리다** (S7 · 전수 검수 §7).
   *
   * 이 경로도 `@CurrentUser` 를 받지 않았고, 쓰는 것은 `issue.progress_page` **한 칸 덮어쓰기**라
   * 이전 쪽수가 그 자리에서 사라졌다. 진도는 §38 트래킹의 퍼센트이자 `patchBook` 의 쪽수 하한
   * (`BOOK_PAGES_BELOW_PROGRESS`)이라 되짚을 수 없으면 두 화면이 왜 그 값인지 아무도 모른다.
   *
   * `hist` 가 아닌 이유는 `patchBook` 과 같다 — 원문 §40 칩에 없는 낱말이고 before/after 칸도 없다.
   */
  async updateIssueProgress(userId: number, id: number, page: number): Promise<BookIssueDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const [ref] = await m.query(`SELECT lib_id FROM issue WHERE id=$1`, [id]) as R[];
      if (!ref) throw new NotFoundException('배부 내역을 찾을 수 없습니다');
      const [lib] = await m.query(`SELECT id,pages FROM lib WHERE id=$1 FOR UPDATE`, [ref.lib_id]) as R[];
      const [r] = await m.query(`SELECT * FROM issue WHERE id=$1 FOR UPDATE`, [id]) as R[];
      if (!r || Number(r.lib_id) !== Number(lib.id)) {
        throw new ConflictException({ code: 'BOOK_ISSUE_MOVED', message: '배부 교재가 바뀌어 다시 시도해 주세요' });
      }
      if (r.state !== 'ok') throw new ConflictException({ code: 'BOOK_NOT_DELIVERED', message: '배부 완료한 교재만 진도를 바꿀 수 있습니다' });
      const why = progressIssue(page, lib.pages == null ? null : Number(lib.pages));
      if (why) throw new BadRequestException(why);
      await m.query(`UPDATE issue SET progress_page=$2 WHERE id=$1`, [id, page]);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'ISSUE',$2,'progress',$3::jsonb,$4::jsonb)`,
        [userId, id,
          JSON.stringify({ progressPage: r.progress_page == null ? null : Number(r.progress_page) }),
          JSON.stringify({ progressPage: page })],
      );
      return this.issueDto({ ...r, pages: lib.pages, progress_page: page });
    });
  }

  async returnIssue(userId: number, id: number, returnedOn = todayKst()): Promise<BookIssueDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const [r] = await m.query(`SELECT i.*,l.pages FROM issue i JOIN lib l ON l.id=i.lib_id WHERE i.id=$1 FOR UPDATE`, [id]) as R[];
      if (!r) throw new NotFoundException('배부 내역을 찾을 수 없습니다');
      if (r.state === 'returned') throw new ConflictException({ code: 'BOOK_ALREADY_RETURNED', message: '이미 회수한 교재입니다' });
      if (!r.issued_on) throw new ConflictException({ code: 'BOOK_NOT_DELIVERED', message: '배부 전 교재는 회수할 수 없습니다' });
      if (returnedOn < dbDay(r.issued_on)) throw new BadRequestException('회수일은 배부일보다 빠를 수 없습니다');
      await m.query(`UPDATE issue SET state='returned',returned_on=$2 WHERE id=$1`, [id, returnedOn]);
      await m.query(histSql(), ['issue', id, 'book_drop', userId]);
      return this.issueDto({ ...r, state: 'returned', returned_on: returnedOn });
    });
  }

  private async packDto(m: EntityManager, id: number, viewer: PackViewer): Promise<BookPackDto> {
    const [r] = await m.query(
      `SELECT g.*, c.name AS coordinator_name, cb.name AS created_by_name,
              db.name AS delivered_by_name, rb.name AS received_by_name,
              ${kstAt('g.delivered_at')} AS delivered_at_kst, ${kstAt('g.received_at')} AS received_at_kst
         FROM gpapack g LEFT JOIN staff c ON c.id=g.coordinator_id LEFT JOIN staff cb ON cb.id=g.created_by
         LEFT JOIN staff db ON db.id=g.delivered_by LEFT JOIN staff rb ON rb.id=g.received_by
        WHERE g.id=$1`, [id],
    ) as R[];
    if (!r) throw new NotFoundException('자료 전달을 찾을 수 없습니다');
    const students = await m.query(`SELECT s.id,s.name,s.grade FROM gpapack_student gs JOIN stu s ON s.id=gs.student_id WHERE gs.gpapack_id=$1 ORDER BY s.name`, [id]) as R[];
    const books = await m.query(
      `SELECT l.id,l.code,l.title,l.level,l.book_level,gl.vers_id,v.se_file_id,v.te_file_id
         FROM gpapack_lib gl JOIN lib l ON l.id=gl.lib_id LEFT JOIN vers v ON v.id=gl.vers_id
        WHERE gl.gpapack_id=$1 ORDER BY l.title`, [id],
    ) as R[];
    const state = String(r.state) as PackState; const packType = String(r.pack_type) as PackType;
    // 교재 줄의 레벨 글자 사각(원문 §41 카드 · g4 §41-3) — 코드표 레벨(N-47)이 있으면 그 낱말, 아직이면 LIB 옛 원문, 없으면 null
    const packBooks = books.map((b) => ({ id: Number(b.id), code: String(b.code), title: String(b.title), level: bookLevelShown(optText(b.book_level), optText(b.level)), versId: b.vers_id == null ? null : Number(b.vers_id), seFileId: b.se_file_id == null ? null : Number(b.se_file_id), teFileId: b.te_file_id == null ? null : Number(b.te_file_id) }));
    const blockers = [
      ...(!r.effective_on ? ['적용일'] : []),
      ...(r.coordinator_id == null ? ['받는 코디네이터'] : []),
      ...(students.length === 0 ? ['학생'] : []),
      ...(packBooks.length === 0 ? ['교재'] : []),
      ...(packBooks.some((book) => book.versId === null) ? ['적용일에 쓰는 교재 판'] : []),
      ...(packBooks.some((book) => book.seFileId === null) ? ['학생용 SE 파일'] : []),
      ...(packBooks.some((book) => book.teFileId === null) ? ['교사용 TE 파일'] : []),
    ];
    return {
      id: Number(r.id), packType, packTypeLabel: PACK_TYPE_LABEL[packType], title: String(r.title),
      memo: (r.memo as string) ?? null, state, stateLabel: PACK_STATE_LABEL[state],
      effectiveOn: r.effective_on ? dbDay(r.effective_on) : null,
      coordinatorId: r.coordinator_id == null ? null : Number(r.coordinator_id), coordinatorName: (r.coordinator_name as string) ?? null,
      createdByName: (r.created_by_name as string) ?? null,
      deliveredAt: (r.delivered_at_kst as string) ?? null, receivedAt: (r.received_at_kst as string) ?? null,
      // 원문 §41 「전달 2026-08-20 · 김범준 · … 수령 08-18 17:20」 — 전달한 사람 이름 (g4 §41-2)
      deliveredByName: (r.delivered_by_name as string) ?? null,
      receivedByName: (r.received_by_name as string) ?? null,
      students: students.map((s) => ({ id: Number(s.id), name: String(s.name), grade: (s.grade as string) ?? null })),
      books: packBooks,
      canDeliver: state === 'pending' && blockers.length === 0,
      // N-88 — 지정 코디네이터 또는 대표 판정. 쓰기 가드와 같은 함수다
      canReceive: packReceiveAllowed(state, r.coordinator_id, viewer),
      deliveryBlockers: blockers,
    };
  }

  async packs(viewer: PackViewer): Promise<BookPacksDto> {
    const ids = await this.q(`SELECT id FROM gpapack ORDER BY created_at DESC,id DESC`);
    const items = await Promise.all(ids.map((r) => this.packDto(this.anyRepo.manager, Number(r.id), viewer)));
    const count = (key: string, label: string, n: number) => ({ key, label, count: n });
    // 원문 레일 「Sophia 2건 미확인 1」 — 미확인 = 전달했는데 아직 수령 확인이 없는 묶음 (g4 §41-5)
    const coordinators = new Map<string, { key: string; label: string; count: number; unreceived: number }>();
    for (const x of items) if (x.coordinatorId && x.coordinatorName) {
      const key = String(x.coordinatorId); const old = coordinators.get(key);
      coordinators.set(key, {
        ...count(key, x.coordinatorName, (old?.count ?? 0) + 1),
        unreceived: (old?.unreceived ?? 0) + (x.state === 'delivered' ? 1 : 0),
      });
    }
    return {
      items,
      types: [count('exam', PACK_TYPE_LABEL.exam, items.filter((x) => x.packType === 'exam').length), count('self', PACK_TYPE_LABEL.self, items.filter((x) => x.packType === 'self').length)],
      coordinators: [...coordinators.values()],
    };
  }

  private async assertPackRefs(m: EntityManager, dto: { coordinatorId?: number; studentIds?: number[]; libIds?: number[] }) {
    if (dto.coordinatorId !== undefined) {
      const [staff] = await m.query(
        `SELECT id,role,can_gpa_pack FROM staff WHERE id=$1 AND active=true`,
        [dto.coordinatorId],
      ) as Array<{ id: string; role: string; can_gpa_pack: boolean | null }>;
      if (!staff || !isRole(staff.role)
        || !hasPerm(staff.role, 'canGpaPack', { canGpaPack: staff.can_gpa_pack })) {
        throw new BadRequestException('자료를 받을 권한이 있는 활성 코디네이터를 선택해 주세요');
      }
    }
    for (const [table, ids, label] of [['stu', dto.studentIds, '학생'], ['lib', dto.libIds, '교재']] as const) {
      if (!ids) continue;
      if (new Set(ids).size !== ids.length) throw new BadRequestException(`${label}${label === '교재' ? '를' : '을'} 중복 선택할 수 없습니다`);
      const rows = await m.query(`SELECT id FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
      if (rows.length !== ids.length) throw new BadRequestException(`존재하지 않는 ${label}이 포함돼 있습니다`);
    }
  }

  /** 적용일에 쓰는 판을 전달 원장에 고정한다. 현재 판을 조회 때마다 다시 고르면 과거 전달물이 바뀐다. */
  private async replacePackBooks(m: EntityManager, packId: number, libIds: number[], effectiveOn: string): Promise<void> {
    await m.query(`DELETE FROM gpapack_lib WHERE gpapack_id=$1`, [packId]);
    for (const libId of libIds) {
      const [version] = await m.query(
        `SELECT id FROM vers WHERE lib_id=$1 AND (from_date IS NULL OR from_date <= $2::date)
          ORDER BY from_date DESC NULLS LAST,activated_at DESC,id DESC LIMIT 1`,
        [libId, effectiveOn],
      ) as R[];
      await m.query(`INSERT INTO gpapack_lib (gpapack_id,lib_id,vers_id) VALUES ($1,$2,$3)`, [packId, libId, version?.id ?? null]);
    }
  }

  async createPack(viewer: PackViewer, dto: BookPackWriteDto): Promise<BookPackDto> {
    if (!dto.title.trim()) throw new BadRequestException({ code: 'PACK_TITLE_REQUIRED', message: '자료 전달 이름을 입력해 주세요' });
    return this.anyRepo.manager.transaction(async (m) => {
      await this.assertPackRefs(m, dto);
      const [r] = await m.query(
        `INSERT INTO gpapack (pack_type,title,memo,effective_on,coordinator_id,created_by,state)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
        [dto.packType, dto.title.trim(), dto.memo?.trim() || null, dto.effectiveOn, dto.coordinatorId, viewer.id],
      ) as R[];
      const id = Number(r.id);
      for (const studentId of dto.studentIds) await m.query(`INSERT INTO gpapack_student VALUES ($1,$2)`, [id, studentId]);
      await this.replacePackBooks(m, id, dto.libIds, dto.effectiveOn);
      // N-73 — 묶음 만들기는 같은 트랜잭션에 감사 한 줄(gpapack.write)
      await audit(m, 'gpapack.write', {
        actorId: viewer.id, entityId: id, action: 'create',
        after: {
          packType: dto.packType, title: dto.title.trim(), effectiveOn: dto.effectiveOn,
          coordinatorId: dto.coordinatorId, studentIds: dto.studentIds, libIds: dto.libIds, state: 'pending',
        },
      });
      return this.packDto(m, id, viewer);
    });
  }

  async patchPack(viewer: PackViewer, id: number, dto: BookPackPatchDto): Promise<BookPackDto> {
    if (dto.title !== undefined && !dto.title.trim()) {
      throw new BadRequestException({ code: 'PACK_TITLE_REQUIRED', message: '자료 전달 이름은 비울 수 없습니다' });
    }
    return this.anyRepo.manager.transaction(async (m) => {
      const [old] = await m.query(
        `SELECT id,state,pack_type,title,coordinator_id,to_char(effective_on,'YYYY-MM-DD') AS effective_on FROM gpapack WHERE id=$1 FOR UPDATE`,
        [id],
      ) as R[];
      if (!old) throw new NotFoundException('자료 전달을 찾을 수 없습니다');
      if (old.state === 'received') throw new ConflictException({ code: 'PACK_ALREADY_RECEIVED', message: '수령 완료한 자료는 수정할 수 없습니다' });
      await this.assertPackRefs(m, dto);
      if (!(dto.effectiveOn ?? old.effective_on) || (dto.coordinatorId ?? old.coordinator_id) == null) {
        throw new ConflictException({
          code: 'PACK_INCOMPLETE',
          message: '레거시 자료 전달은 적용일과 받는 코디네이터를 함께 채워야 수정할 수 있습니다',
        });
      }
      await m.query(
        `UPDATE gpapack SET pack_type=COALESCE($2,pack_type),title=COALESCE($3,title),memo=COALESCE($4,memo),
         effective_on=COALESCE($5,effective_on),coordinator_id=COALESCE($6,coordinator_id),
         state='pending',delivered_by=NULL,delivered_at=NULL,updated_at=now() WHERE id=$1`,
        [id, dto.packType ?? null, dto.title?.trim() ?? null, dto.memo?.trim() ?? null, dto.effectiveOn ?? null, dto.coordinatorId ?? null],
      );
      if (dto.studentIds) { await m.query(`DELETE FROM gpapack_student WHERE gpapack_id=$1`, [id]); for (const x of dto.studentIds) await m.query(`INSERT INTO gpapack_student VALUES ($1,$2)`, [id, x]); }
      if (dto.libIds) await this.replacePackBooks(m, id, dto.libIds, dto.effectiveOn ?? (old.effective_on ? dbDay(old.effective_on) : todayKst()));
      else if (dto.effectiveOn) {
        const linked = await m.query(`SELECT lib_id FROM gpapack_lib WHERE gpapack_id=$1 ORDER BY lib_id`, [id]) as R[];
        await this.replacePackBooks(m, id, linked.map((row) => Number(row.lib_id)), dto.effectiveOn);
      }
      /*
       * N-73 — 고치기는 전달 도장(누가 · 언제 전달)을 지우고 준비 중으로 되돌린다. 보낸 칸만 적는다(PATCH 규약) —
       * 안 보낸 칸까지 적으면 안 바뀐 값이 바뀐 것처럼 읽힌다. 메모 본문은 길어 원장에 옮기지 않는다(바뀌었는지만).
       */
      const sent = Object.fromEntries(Object.entries({
        packType: dto.packType, title: dto.title?.trim(), effectiveOn: dto.effectiveOn,
        coordinatorId: dto.coordinatorId, studentIds: dto.studentIds, libIds: dto.libIds,
        memoChanged: dto.memo === undefined ? undefined : true,
      }).filter(([, value]) => value !== undefined));
      await audit(m, 'gpapack.write', {
        actorId: viewer.id, entityId: id, action: 'patch',
        before: {
          state: old.state, packType: old.pack_type, title: old.title,
          effectiveOn: old.effective_on ? dbDay(old.effective_on) : null,
          coordinatorId: old.coordinator_id == null ? null : Number(old.coordinator_id),
        },
        after: { ...sent, state: 'pending' },
      });
      return this.packDto(m, id, viewer);
    });
  }

  async transitionPack(viewer: PackViewer, id: number, target: PackState): Promise<BookPackDto> {
    const userId = viewer.id;
    return this.anyRepo.manager.transaction(async (m) => {
      const [r] = await m.query(`SELECT id,state,coordinator_id FROM gpapack WHERE id=$1 FOR UPDATE`, [id]) as R[];
      if (!r) throw new NotFoundException('자료 전달을 찾을 수 없습니다');
      const why = packTransitionIssue(String(r.state) as PackState, target);
      if (why) throw new ConflictException({ code: 'PACK_INVALID_TRANSITION', message: why });
      if (target === 'delivered') {
        const before = await this.packDto(m, id, viewer);
        if (!before.canDeliver) {
          throw new ConflictException({ code: 'PACK_NOT_READY', message: `전달 전에 확인해 주세요: ${before.deliveryBlockers.join(' · ')}` });
        }
        await m.query(`UPDATE gpapack SET state='delivered',delivered_by=$2,delivered_at=now(),updated_at=now() WHERE id=$1`, [id, userId]);
        await audit(m, 'gpapack.write', { actorId: userId, entityId: id, action: 'deliver', before: { state: 'pending' }, after: { state: 'delivered' } });
      } else {
        // N-88 — 지정 코디네이터 또는 대표 판정. 응답의 canReceive 와 같은 함수다 · 누른 사람이 received_by 에 남는다
        if (!packReceiveAllowed(String(r.state), r.coordinator_id, viewer)) {
          throw new ConflictException({ code: 'PACK_RECEIVER_ONLY', message: '지정된 코디네이터나 대표만 수령을 확인할 수 있습니다' });
        }
        await m.query(`UPDATE gpapack SET state='received',received_by=$2,received_at=now(),updated_at=now() WHERE id=$1`, [id, userId]);
        await audit(m, 'gpapack.write', {
          actorId: userId, entityId: id, action: 'receive',
          before: { state: 'delivered' },
          after: { state: 'received', receivedBy: userId, coordinatorId: Number(r.coordinator_id) },
        });
        const [pack] = await m.query(`SELECT title FROM gpapack WHERE id=$1`, [id]) as Array<{ title: string }>;
        const heads = await m.query(
          `SELECT id,role,can_gpa_pack FROM staff WHERE active=true AND id<>$1 ORDER BY id`,
          [userId],
        ) as Array<{ id: string; role: string; can_gpa_pack: boolean | null }>;
        for (const head of heads.filter((staff) => isRole(staff.role)
          && hasPerm(staff.role, 'canAdminPage')
          && hasPerm(staff.role, 'canGpaPack', { canGpaPack: staff.can_gpa_pack }))) {
          await m.query(
            `INSERT INTO noti (to_id,from_id,body,link,category,title) VALUES ($1,$2,$3,'/books?tab=requests','request',$4)`,
            [Number(head.id), userId, `자료 수령 확인 · ${pack.title}`, NOTI_TITLE.bookReceived],
          );
        }
      }
      return this.packDto(m, id, viewer);
    });
  }

}
