/** @file-guide
 * 목적: books.service.ts — BooksService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { histLabel, histSql } from '../../lib/history';
import { todayKst } from '../../lib/kst';
import { kstAt } from '../../lib/sql';
import type {
  BookHistoryRowDto, BookVersionCreateDto, BookVersionDto, BooksDto,
} from './books.dto';

type R = Record<string, unknown>;

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
              cur.id AS vers_id, cur.edition, cur.file_url,
              top.edition AS latest_edition, top.id AS latest_vers_id
         FROM lib l
         LEFT JOIN sub s ON s.key = l.sub_key
         LEFT JOIN LATERAL (
           SELECT v.id, v.edition, v.file_url FROM vers v
            WHERE v.lib_id = l.id AND (v.from_date IS NULL OR v.from_date <= $1::date)
            ORDER BY v.from_date DESC NULLS LAST, v.id DESC LIMIT 1) cur ON true
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
        hasFile: r.file_url !== null && r.file_url !== undefined,
      };
    });

    return {
      bySub,
      items,
      newerCount: items.filter((i) => i.hasNewer).length,
      // 판이 아예 없는 교재도 「보낼 파일이 없다」에 든다 — 강사에게 줄 것이 없는 것은 같다
      noFileCount: items.filter((i) => !i.hasFile).length,
    };
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
    return this.anyRepo.manager.transaction(async (m: EntityManager) => {
      const [lib] = (await m.query(`SELECT id, title FROM lib WHERE id = $1`, [libId])) as Array<{ id: string }>;
      if (!lib) throw new NotFoundException('교재를 찾을 수 없습니다');

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
        `INSERT INTO vers (lib_id, edition, file_url, from_date)
         VALUES ($1, $2, $3, $4::date) RETURNING id, lib_id, edition, file_url, to_char(from_date,'YYYY-MM-DD') AS from_date`,
        [libId, dto.edition, dto.fileUrl ?? null, dto.fromDate ?? today],
      )) as Array<R>;
      await m.query(histSql(), ['vers', Number(made.id), 'book_upload', userId]);

      return {
        id: Number(made.id), libId: Number(made.lib_id), edition: String(made.edition),
        fileUrl: (made.file_url as string) ?? null,
        fromDate: (made.from_date as string) ?? null,
        inUse: (made.from_date as string | null) === null || String(made.from_date) <= today,
      };
    });
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
      const [v] = (await m.query(
        `SELECT id, lib_id, edition, file_url, to_char(from_date,'YYYY-MM-DD') AS from_date
           FROM vers WHERE id = $1 FOR UPDATE`, [versId],
      )) as Array<R>;
      if (!v) throw new NotFoundException('판을 찾을 수 없습니다');

      const from = (v.from_date as string) ?? null;
      if (from !== null && from <= today) {
        throw new ConflictException({
          code: 'VERS_ALREADY_IN_USE',
          message: `「${String(v.edition)}」 판은 이미 ${from} 부터 쓰고 있습니다`,
        });
      }

      await m.query(`UPDATE vers SET from_date = $2::date WHERE id = $1`, [versId, today]);
      await m.query(histSql(), ['vers', versId, 'book_swap', userId]);

      return {
        id: Number(v.id), libId: Number(v.lib_id), edition: String(v.edition),
        fileUrl: (v.file_url as string) ?? null, fromDate: today, inUse: true,
      };
    });
  }

  /* ══ §40 교재 이력 — 읽기만 한다 (C52) ════════════════════════════════════ */

  /**
   * 이력 줄. **문장은 읽을 때 만든다** — 쓸 때 굳혀 두면 교재 이름이 바뀌어도
   * 이력만 옛 이름으로 남는다. `hist` 에 설명 칸이 없는 것이 그 설계다.
   */
  async history(limit = 200): Promise<BookHistoryRowDto[]> {
    const rows = await this.q(
      `SELECT h.id, h.entity, h.ref_id, h.action, ${kstAt('h.at')} AS at,
              st.name AS by_name,
              CASE h.entity
                WHEN 'vers'  THEN (SELECT l.title || ' · ' || v.edition
                                     FROM vers v JOIN lib l ON l.id = v.lib_id WHERE v.id = h.ref_id)
                WHEN 'lib'   THEN (SELECT l.title FROM lib l WHERE l.id = h.ref_id)
                WHEN 'issue' THEN (SELECT s.name || ' · ' || l.title
                                     FROM issue i JOIN lib l ON l.id = i.lib_id
                                     JOIN stu s ON s.id = i.student_id WHERE i.id = h.ref_id)
                WHEN 'guide' THEN (SELECT s.name FROM guide g JOIN stu s ON s.id = g.student_id WHERE g.id = h.ref_id)
                ELSE NULL
              END AS subject
         FROM hist h
         LEFT JOIN staff st ON st.id = h.by_id
        ORDER BY h.at DESC, h.id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id), action: String(r.action), actionLabel: histLabel(String(r.action)),
      entity: String(r.entity), refId: Number(r.ref_id),
      subject: (r.subject as string) ?? null,
      byName: (r.by_name as string) ?? null,
      at: String(r.at),
    }));
  }

}
