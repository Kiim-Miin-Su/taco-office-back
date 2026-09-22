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
import { kstAt, serStuOn } from '../../lib/sql';
import {
  ISSUE_STATE_LABEL, PACK_STATE_LABEL, PACK_TYPE_LABEL, issueTransitionIssue, packTransitionIssue,
  progressIssue, progressPercent, type IssueState, type PackState, type PackType,
} from '../../lib/book';
import type {
  BookHistoryDto, BookHistoryQueryDto, BookHistoryRowDto, BookIssueCreateDto, BookIssueDto,
  BookPackDto, BookPackPatchDto, BookPacksDto, BookPackWriteDto,
  BookPatchDto, BookTrackingDto, BookVersionCreateDto, BookVersionDto, BooksDto, BookWriteDto,
} from './books.dto';
import { prepareFile, storePreparedFile } from '../files/files.service';
import { FILE_MAX_BYTES } from '../files/files.dto';
import { hasPerm, isRole } from '../../common/perm';

type R = Record<string, unknown>;

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

@Injectable()
export class BooksService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  async all(): Promise<BooksDto> {
    /*
     * 「지금 쓰는 판」은 **시작일이 오늘 이하인 것 중 가장 나중 것**이다.
     * 「가장 나중 판」은 시작일과 상관없이 제일 나중 것 — 둘이 다르면 아직 시작 안 한 판이 있다는 뜻이고,
     * 그게 원본 §39 의 ⇧ 배지와 「더 최신 판이 있는 교재 N종」 띠다.
     * **비교를 여기서 한 번만 한다** — 화면이 두 낱말을 다시 비교하면 배지와 띠가 갈린다 (D-R39).
     */
    const rows = await this.q(
      `SELECT l.id, l.code, l.title, l.sub_key, l.level, l.grade, l.pages, l.se_te, s.name AS sub_name,
              cur.id AS vers_id, cur.edition, cur.file_url, cur.se_file_id, cur.te_file_id,
              top.edition AS latest_edition, top.id AS latest_vers_id,
              (SELECT count(*)::int FROM issue i WHERE i.lib_id = l.id) AS issue_count
         FROM lib l
         LEFT JOIN sub s ON s.key = l.sub_key
         LEFT JOIN LATERAL (
           SELECT v.id, v.edition, v.file_url, v.se_file_id, v.te_file_id FROM vers v
            WHERE v.lib_id = l.id AND (v.from_date IS NULL OR v.from_date <= $1::date)
            ORDER BY v.from_date DESC NULLS LAST, v.activated_at DESC, v.id DESC LIMIT 1) cur ON true
         LEFT JOIN LATERAL (
           SELECT v.id, v.edition FROM vers v
            WHERE v.lib_id = l.id
            ORDER BY v.from_date DESC NULLS LAST, v.id DESC LIMIT 1) top ON true
        ORDER BY l.sub_key NULLS LAST, l.code`,
      [todayKst()],
    );

    const bySub: Record<string, number> = {};
    for (const r of rows) {
      const k = (r.sub_name as string) ?? '미분류';
      bySub[k] = (bySub[k] ?? 0) + 1;
    }

    const items = rows.map((r) => {
      const edition = (r.edition as string) ?? null;
      const latest = (r.latest_edition as string) ?? null;
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
      };
    });
    const namedCounts = (values: Array<string | null>) => [...values.reduce((map, value) => {
      if (!value) return map;
      const old = map.get(value);
      map.set(value, { key: value, label: value, count: (old?.count ?? 0) + 1 });
      return map;
    }, new Map<string, { key: string; label: string; count: number }>()).values()].sort((a, b) => a.label.localeCompare(b.label));

    return {
      bySub,
      items,
      newerCount: items.filter((i) => i.hasNewer).length,
      // 원본 §39의 경고는 일반 파일이 아니라 교사용 TE 파일 누락을 센다.
      noFileCount: items.filter((i) => i.teFileId === null).length,
      levels: [...new Set(items.map((i) => i.level).filter((x): x is string => Boolean(x)))].sort(),
      grades: [...new Set(items.map((i) => i.grade).filter((x): x is string => Boolean(x)))].sort(),
      levelCounts: namedCounts(items.map((item) => item.level)),
      gradeCounts: namedCounts(items.map((item) => item.grade)),
      versionUploadMaxBytes: FILE_MAX_BYTES,
    };
  }

  async createBook(userId: number, dto: BookWriteDto) {
    const code = dto.code.trim(); const title = dto.title.trim();
    if (!code || !title) throw new BadRequestException({ code: 'BOOK_TEXT_REQUIRED', message: '교재 코드와 이름을 입력해 주세요' });
    try {
      return await this.anyRepo.manager.transaction(async (m) => {
        if (dto.subKey) {
          const [subject] = await m.query(`SELECT key FROM sub WHERE key = $1`, [dto.subKey]);
          if (!subject) throw new BadRequestException({ code: 'BOOK_SUBJECT_NOT_FOUND', message: '과목을 찾을 수 없습니다' });
        }
        const dup = await m.query(`SELECT id FROM lib WHERE code = $1`, [code]);
        if (dup.length) throw new ConflictException({ code: 'BOOK_CODE_DUPLICATE', message: '이미 쓰는 교재 코드입니다' });
        const [row] = await m.query(
          `INSERT INTO lib (code,title,sub_key,level,grade,pages) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id,code,title`,
          [code, title, dto.subKey ?? null, dto.level ?? null, dto.grade ?? null, dto.pages ?? null],
        ) as R[];
        await m.query(histSql(), ['lib', Number(row.id), 'book_upload', userId]);
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
    const col: Record<string, string> = { code: 'code', title: 'title', subKey: 'sub_key', level: 'level', grade: 'grade', pages: 'pages' };
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
    const today = todayKst();
    try {
      return await this.anyRepo.manager.transaction(async (m: EntityManager) => {
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
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'VERS_DUPLICATE', message: `이 교재에 「${dto.edition}」 판은 이미 있습니다` });
      }
      throw error;
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
              CASE WHEN h.entity='guide' THEN (SELECT g.body FROM guide g WHERE g.id=h.ref_id) END AS memo,
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
      subject: (r.subject as string) ?? null,
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
    };
  }

  async tracking(): Promise<BookTrackingDto> {
    const rows = await this.q(
      `SELECT s.id AS student_id, s.name, s.grade,
              i.id, i.lib_id, i.vers_id, i.state, i.progress_page,
              to_char(i.issued_on,'YYYY-MM-DD') AS issued_on, to_char(i.returned_on,'YYYY-MM-DD') AS returned_on,
              l.title, l.pages, v.edition, v.file_url, v.se_file_id, v.te_file_id,
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
      libId: number; title: string; studentCount: number; values: number[]; pages: number | null;
      students: Array<{ studentId: number; name: string; percent: number | null; elapsedDays: number | null }>;
    }>();
    for (const r of active) {
      const libId = Number(r.lib_id); const old = bookMap.get(libId) ?? {
        libId, title: String(r.title), studentCount: 0, values: [],
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
      if (auto) todos.push({ key: 'auto', label: '안내 발송 대기', count: auto });
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
    };
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
      try {
        const [row] = await m.query(
          `INSERT INTO issue (lib_id,vers_id,student_id,issued_on,state,progress_page,requested_by,approved_by,delivered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, NULL::int AS pages`,
          [dto.libId, version?.id ?? null, dto.studentId, issuedOn, state, dto.progressPage ?? null,
           userId, state === 'ok' ? userId : null, state === 'ok' ? new Date() : null],
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

  private async packDto(m: EntityManager, id: number, viewerId: number): Promise<BookPackDto> {
    const [r] = await m.query(
      `SELECT g.*, c.name AS coordinator_name, cb.name AS created_by_name,
              ${kstAt('g.delivered_at')} AS delivered_at_kst, ${kstAt('g.received_at')} AS received_at_kst
         FROM gpapack g LEFT JOIN staff c ON c.id=g.coordinator_id LEFT JOIN staff cb ON cb.id=g.created_by
        WHERE g.id=$1`, [id],
    ) as R[];
    if (!r) throw new NotFoundException('자료 전달을 찾을 수 없습니다');
    const students = await m.query(`SELECT s.id,s.name,s.grade FROM gpapack_student gs JOIN stu s ON s.id=gs.student_id WHERE gs.gpapack_id=$1 ORDER BY s.name`, [id]) as R[];
    const books = await m.query(
      `SELECT l.id,l.code,l.title,gl.vers_id,v.se_file_id,v.te_file_id
         FROM gpapack_lib gl JOIN lib l ON l.id=gl.lib_id LEFT JOIN vers v ON v.id=gl.vers_id
        WHERE gl.gpapack_id=$1 ORDER BY l.title`, [id],
    ) as R[];
    const state = String(r.state) as PackState; const packType = String(r.pack_type) as PackType;
    const packBooks = books.map((b) => ({ id: Number(b.id), code: String(b.code), title: String(b.title), versId: b.vers_id == null ? null : Number(b.vers_id), seFileId: b.se_file_id == null ? null : Number(b.se_file_id), teFileId: b.te_file_id == null ? null : Number(b.te_file_id) }));
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
      students: students.map((s) => ({ id: Number(s.id), name: String(s.name), grade: (s.grade as string) ?? null })),
      books: packBooks,
      canDeliver: state === 'pending' && blockers.length === 0,
      canReceive: state === 'delivered' && r.coordinator_id != null && Number(r.coordinator_id) === viewerId,
      deliveryBlockers: blockers,
    };
  }

  async packs(viewerId: number): Promise<BookPacksDto> {
    const ids = await this.q(`SELECT id FROM gpapack ORDER BY created_at DESC,id DESC`);
    const items = await Promise.all(ids.map((r) => this.packDto(this.anyRepo.manager, Number(r.id), viewerId)));
    const count = (key: string, label: string, n: number) => ({ key, label, count: n });
    const coordinators = new Map<string, { key: string; label: string; count: number }>();
    for (const x of items) if (x.coordinatorId && x.coordinatorName) {
      const key = String(x.coordinatorId); const old = coordinators.get(key);
      coordinators.set(key, count(key, x.coordinatorName, (old?.count ?? 0) + 1));
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

  async createPack(userId: number, dto: BookPackWriteDto): Promise<BookPackDto> {
    if (!dto.title.trim()) throw new BadRequestException({ code: 'PACK_TITLE_REQUIRED', message: '자료 전달 이름을 입력해 주세요' });
    return this.anyRepo.manager.transaction(async (m) => {
      await this.assertPackRefs(m, dto);
      const [r] = await m.query(
        `INSERT INTO gpapack (pack_type,title,memo,effective_on,coordinator_id,created_by,state)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
        [dto.packType, dto.title.trim(), dto.memo?.trim() || null, dto.effectiveOn, dto.coordinatorId, userId],
      ) as R[];
      const id = Number(r.id);
      for (const studentId of dto.studentIds) await m.query(`INSERT INTO gpapack_student VALUES ($1,$2)`, [id, studentId]);
      await this.replacePackBooks(m, id, dto.libIds, dto.effectiveOn);
      return this.packDto(m, id, userId);
    });
  }

  async patchPack(userId: number, id: number, dto: BookPackPatchDto): Promise<BookPackDto> {
    if (dto.title !== undefined && !dto.title.trim()) {
      throw new BadRequestException({ code: 'PACK_TITLE_REQUIRED', message: '자료 전달 이름은 비울 수 없습니다' });
    }
    return this.anyRepo.manager.transaction(async (m) => {
      const [old] = await m.query(
        `SELECT id,state,coordinator_id,to_char(effective_on,'YYYY-MM-DD') AS effective_on FROM gpapack WHERE id=$1 FOR UPDATE`,
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
      return this.packDto(m, id, userId);
    });
  }

  async transitionPack(userId: number, id: number, target: PackState): Promise<BookPackDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const [r] = await m.query(`SELECT id,state,coordinator_id FROM gpapack WHERE id=$1 FOR UPDATE`, [id]) as R[];
      if (!r) throw new NotFoundException('자료 전달을 찾을 수 없습니다');
      const why = packTransitionIssue(String(r.state) as PackState, target);
      if (why) throw new ConflictException({ code: 'PACK_INVALID_TRANSITION', message: why });
      if (target === 'delivered') {
        const before = await this.packDto(m, id, userId);
        if (!before.canDeliver) {
          throw new ConflictException({ code: 'PACK_NOT_READY', message: `전달 전에 확인해 주세요: ${before.deliveryBlockers.join(' · ')}` });
        }
        await m.query(`UPDATE gpapack SET state='delivered',delivered_by=$2,delivered_at=now(),updated_at=now() WHERE id=$1`, [id, userId]);
      } else {
        if (Number(r.coordinator_id) !== userId) throw new ConflictException({ code: 'PACK_RECEIVER_ONLY', message: '지정된 코디네이터만 수령을 확인할 수 있습니다' });
        await m.query(`UPDATE gpapack SET state='received',received_by=$2,received_at=now(),updated_at=now() WHERE id=$1`, [id, userId]);
        const [pack] = await m.query(`SELECT title FROM gpapack WHERE id=$1`, [id]) as Array<{ title: string }>;
        const heads = await m.query(
          `SELECT id,role,can_gpa_pack FROM staff WHERE active=true AND id<>$1 ORDER BY id`,
          [userId],
        ) as Array<{ id: string; role: string; can_gpa_pack: boolean | null }>;
        for (const head of heads.filter((staff) => isRole(staff.role)
          && hasPerm(staff.role, 'canAdminPage')
          && hasPerm(staff.role, 'canGpaPack', { canGpaPack: staff.can_gpa_pack }))) {
          await m.query(
            `INSERT INTO noti (to_id,from_id,body,link,category) VALUES ($1,$2,$3,'/books?tab=requests','request')`,
            [Number(head.id), userId, `자료 수령 확인 · ${pack.title}`],
          );
        }
      }
      return this.packDto(m, id, userId);
    });
  }

}
