/** @file-guide
 * 목적: guides.service.ts — GuidesService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { histSql } from '../../lib/history';
import { GUIDE_DONE_DB, GUIDE_PENDING_DB } from '../../lib/rules';
import type { GuideBodyDto, GuideTemplateDto, GuideTemplateWriteDto, GuidesDto } from './guides.dto';
import { kstAt, writtenRows } from '../../lib/sql';
import { overdueDays as overdue } from '../../lib/kst';

type R = Record<string, unknown>;


@Injectable()
export class GuidesService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /** teacherId 가 있으면 그 강사 것만 — 화면이 안 걸러도 서버가 거른다 (D-R39). */
  async all(teacherId?: number): Promise<GuidesDto> {
    const only = teacherId !== undefined;

    const guides = (await this.q(
      `SELECT g.id, g.reason, g.state, g.body,
              to_char(g.due_on,'YYYY-MM-DD')     AS due_on,
              to_char(g.created_at,'YYYY-MM-DD') AS created_at,
              s.name AS student_name, t.name AS teacher_name, r.title AS ser_title
         FROM guide g
         LEFT JOIN stu   s ON s.id = g.student_id
         LEFT JOIN staff t ON t.id = g.teacher_id
         LEFT JOIN ser   r ON r.id = g.ser_id
        WHERE ($1::bigint IS NULL OR g.teacher_id = $1)
        ORDER BY (g.state = ANY($2)) DESC, g.due_on NULLS LAST, g.id`,
      [only ? teacherId : null, [...GUIDE_PENDING_DB]],
    )).map((r) => {
      // 「보내야 함」은 여기 한 곳에서 판정한다 — 화면·기한 계산·todoCount가 같은 값을 읽는다.
      const pending = (GUIDE_PENDING_DB as readonly string[]).includes(String(r.state));
      return {
        id: Number(r.id), reason: String(r.reason), state: String(r.state), pending,
        studentName: (r.student_name as string) ?? null,
        teacherName: (r.teacher_name as string) ?? null,
        serTitle: (r.ser_title as string) ?? null,
        body: (r.body as string) ?? null,
        dueOn: (r.due_on as string) ?? null,
        createdAt: String(r.created_at),
        overdueDays: pending ? overdue(r.due_on as string) : 0,
      };
    });

    const perLesson = (await this.q(
      `SELECT p.id, to_char(p.on_date,'YYYY-MM-DD') AS on_date, p.channel, p.body,
              ${kstAt(`p.sent_at`)} AS sent_at,
              s.name AS student_name, r.title AS ser_title
         FROM pnoti p
         LEFT JOIN stu s ON s.id = p.student_id
         LEFT JOIN ser r ON r.id = p.ser_id
        WHERE ($1::bigint IS NULL OR r.teacher_id = $1)
        ORDER BY p.on_date DESC, p.id`,
      [only ? teacherId : null],
    )).map((r) => ({
      id: Number(r.id), onDate: String(r.on_date), channel: String(r.channel),
      studentName: (r.student_name as string) ?? null,
      serTitle: (r.ser_title as string) ?? null,
      body: String(r.body),
      sentAt: (r.sent_at as string) ?? null,
    }));

    return {
      guides,
      perLesson,
      todoCount:
        guides.filter((g) => g.pending).length +
        perLesson.filter((p) => !p.sentAt).length,
      scopedTeacherId: only ? teacherId! : null,
    };
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
    const [made] = await this.q(
      `INSERT INTO gtpl (name, body) VALUES ($1, $2) RETURNING id, name, body`, [name, dto.body],
    );
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
    const rows = await this.q(
      `UPDATE gtpl SET name = $2, body = $3 WHERE id = $1 RETURNING id, name, body`, [id, name, dto.body],
    );
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
    const [cur] = await this.q(`SELECT id, state FROM guide WHERE id = $1`, [id]);
    if (!cur) throw new NotFoundException('안내를 찾을 수 없습니다');
    if ((GUIDE_DONE_DB as readonly string[]).includes(String(cur.state))) {
      throw new ConflictException({
        code: 'GUIDE_ALREADY_SENT',
        message: '이미 보낸 안내는 고칠 수 없습니다 — 새 안내를 만드세요',
      });
    }
    /*
     * 이력과 **같은 트랜잭션**에서 남긴다 (§40 「여기에 남는 것」에 「수업 안내 작성」이 있다).
     * 밖에서 남기면 쓰기는 되돌아가고 이력만 남아 「하지도 않은 일」이 장부에 찍힌다.
     */
    await this.anyRepo.manager.transaction(async (m) => {
      await m.query(`UPDATE guide SET body = $2, state = 'ready'::guide_state_t WHERE id = $1`, [id, dto.body]);
      await m.query(histSql(), ['guide', id, 'guide_write', userId]);
    });
    const one = await this.all();
    const found = one.guides.find((g) => g.id === id);
    if (!found) throw new NotFoundException('안내를 찾을 수 없습니다');
    return found;
  }

}
