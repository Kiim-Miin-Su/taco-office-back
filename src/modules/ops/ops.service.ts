import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import type { OpsDto } from './ops.dto';

const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const daysSince = (d?: string | null) =>
  d ? Math.max(0, Math.floor((new Date(`${todayKst()}T00:00:00Z`).getTime() - new Date(`${d}T00:00:00Z`).getTime()) / 86400000)) : 0;

type R = Record<string, unknown>;

@Injectable()
export class OpsService {
  constructor(@InjectRepository(Lead) private readonly lead: Repository<Lead>) {}

  private q<T = R>(sql: string): Promise<T[]> {
    return this.lead.query(sql) as Promise<T[]>;
  }

  async all(canSeeAmounts: boolean): Promise<OpsDto> {
    const today = todayKst();

    const leads = (await this.q(
      `SELECT l.id, l.name, l.school, l.stage, l.stop_at, l.reason,
              to_char(l.created_at,'YYYY-MM-DD') AS created_at, o.name AS owner_name
         FROM lead l LEFT JOIN staff o ON o.id = l.owner_id
        ORDER BY l.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), name: String(r.name), school: (r.school as string) ?? null,
      stage: String(r.stage), ownerName: (r.owner_name as string) ?? null,
      stopAt: (r.stop_at as string) ?? null, reason: (r.reason as string) ?? null,
      createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
    }));

    const complaints = (await this.q(
      `SELECT c.id, c.area, s.name AS student_name, c.stage, c.body, c.action, c.result,
              to_char(c.created_at,'YYYY-MM-DD') AS created_at
         FROM cpl c LEFT JOIN stu s ON s.id = c.student_id
        ORDER BY (c.stage = 'received') DESC, c.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), area: String(r.area), studentName: (r.student_name as string) ?? null,
      stage: String(r.stage), body: String(r.body),
      action: (r.action as string) ?? null, result: (r.result as string) ?? null,
      createdAt: String(r.created_at), ageDays: daysSince(r.created_at as string),
    }));

    const todos = (await this.q(
      `SELECT t.id, t.title, t.done, t.src, to_char(t.due_on,'YYYY-MM-DD') AS due_on, s.name AS to_name
         FROM todo t LEFT JOIN staff s ON s.id = t.to_id
        ORDER BY t.done, t.due_on NULLS LAST, t.id`,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      return {
        id: Number(r.id), title: String(r.title), toName: (r.to_name as string) ?? null,
        dueOn: due, done: Boolean(r.done), src: String(r.src),
        overdueDays: !r.done && due && due < today ? daysSince(due) : 0,
      };
    });

    const plans = (await this.q(
      `SELECT p.id, p.title, p.stage, p.goal, p.ask, to_char(p.due_on,'YYYY-MM-DD') AS due_on, s.name AS owner_name
         FROM plan p LEFT JOIN staff s ON s.id = p.owner_id ORDER BY p.due_on NULLS LAST, p.id`,
    )).map((r) => {
      const due = (r.due_on as string) ?? null;
      const open = r.stage !== 'done' && r.stage !== 'approved';
      return {
        id: Number(r.id), title: String(r.title), stage: String(r.stage),
        goal: (r.goal as string) ?? null, ask: (r.ask as string) ?? null,
        dueOn: due, ownerName: (r.owner_name as string) ?? null,
        overdueDays: open && due && due < today ? daysSince(due) : 0,
      };
    });

    const meetings = (await this.q(
      `SELECT m.id, m.mt_type, m.title, to_char(m.on_date,'YYYY-MM-DD') AS on_date, m.minutes,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id)::int AS attendees,
              (SELECT count(*) FROM mtattd a WHERE a.mt_id = m.id AND a.confirmed)::int AS confirmed
         FROM mtrec m ORDER BY m.on_date DESC NULLS LAST, m.id DESC`,
    )).map((r) => ({
      id: Number(r.id), mtType: String(r.mt_type), title: (r.title as string) ?? null,
      onDate: (r.on_date as string) ?? null,
      attendees: Number(r.attendees), confirmed: Number(r.confirmed),
      hasMinutes: Boolean(r.minutes),
    }));

    const marketing = (await this.q(
      `SELECT id, channel, item, url, result FROM mkt ORDER BY (result->>'enrolled')::int DESC NULLS LAST, id`,
    )).map((r) => {
      const res = (r.result ?? {}) as Record<string, number>;
      const enrolled = res.enrolled ?? 0;
      const cost = res.cost ?? 0;
      return {
        id: Number(r.id), channel: String(r.channel), item: String(r.item), url: (r.url as string) ?? null,
        impressions: res.impressions ?? null, clicks: res.clicks ?? null,
        inquiries: res.inquiries ?? null, enrolled,
        // 비용은 대표만 (D-R39) — 서버가 안 내려보낸다
        cost: canSeeAmounts ? cost : null,
        costPerEnroll: canSeeAmounts && enrolled > 0 ? Math.round(cost / enrolled) : null,
      };
    });

    const suggestions = (await this.q(
      `SELECT g.id, s.name AS staff_name, g.category, g.body, g.state, g.reply,
              to_char(g.created_at,'YYYY-MM-DD') AS created_at
         FROM suggestion g JOIN staff s ON s.id = g.staff_id ORDER BY g.created_at DESC`,
    )).map((r) => ({
      id: Number(r.id), staffName: String(r.staff_name), category: String(r.category),
      body: String(r.body), state: String(r.state), reply: (r.reply as string) ?? null,
      createdAt: String(r.created_at),
    }));

    return { leads, complaints, todos, plans, meetings, marketing, suggestions, canSeeAmounts };
  }
}
