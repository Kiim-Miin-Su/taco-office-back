import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { GUIDE_PENDING_DB } from '../../lib/rules';
import type { GuidesDto } from './guides.dto';
import { kstAt } from '../../lib/sql';
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
    )).map((r) => ({
      id: Number(r.id), reason: String(r.reason), state: String(r.state),
      studentName: (r.student_name as string) ?? null,
      teacherName: (r.teacher_name as string) ?? null,
      serTitle: (r.ser_title as string) ?? null,
      body: (r.body as string) ?? null,
      dueOn: (r.due_on as string) ?? null,
      createdAt: String(r.created_at),
      overdueDays: (GUIDE_PENDING_DB as readonly string[]).includes(String(r.state))
        ? overdue(r.due_on as string) : 0,
    }));

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
        guides.filter((g) => (GUIDE_PENDING_DB as readonly string[]).includes(g.state)).length +
        perLesson.filter((p) => !p.sentAt).length,
      scopedTeacherId: only ? teacherId! : null,
    };
  }
}
