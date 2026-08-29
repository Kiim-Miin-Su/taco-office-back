import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rep } from '../../entities';
import { LATE_REPORT_TIERS, REPORT_WRITTEN, tierFor, type ReportState } from '../../lib/rules';
import type { ReportRowDto, UnwrittenDto } from './reports.dto';

interface Row {
  id: string; ser_id: string; on_date: string; start_min: number; end_min_utc: string;
  sub_key: string | null; kind_key: string;
  teacher_id: string | null; teacher_name: string | null; state: string;
  students: Array<{ id: number; name: string; grade: string | null }> | null;
}

@Injectable()
export class ReportsService {
  constructor(@InjectRepository(Rep) private readonly reps: Repository<Rep>) {}

  private static sql(where: string): string {
    return `SELECT r.id, r.ser_id, to_char(r.on_date, 'YYYY-MM-DD') AS on_date,
                   (EXTRACT(HOUR FROM lower(o.span) AT TIME ZONE 'Asia/Seoul') * 60
                    + EXTRACT(MINUTE FROM lower(o.span) AT TIME ZONE 'Asia/Seoul'))::int AS start_min,
                   to_char(upper(o.span) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_min_utc,
                   r.kind_key, s.sub_key, r.teacher_id, t.name AS teacher_name, r.state,
                   COALESCE((
                     SELECT json_agg(json_build_object('id', st.id, 'name', st.name, 'grade', st.grade) ORDER BY st.id)
                     FROM rep_stu rs JOIN stu st ON st.id = rs.student_id WHERE rs.rep_id = r.id
                   ), '[]'::json) AS students
              FROM rep r
              JOIN ser s ON s.id = r.ser_id
              LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
              LEFT JOIN staff t ON t.id = r.teacher_id
             WHERE ${where}
             ORDER BY r.on_date DESC, start_min DESC`;
  }

  /** 판정은 rules.ts 한 곳에서만 — 화면도 이 결과를 읽기만 한다 */
  private toRow(r: Row, now: Date): ReportRowDto {
    const end = r.end_min_utc ? new Date(r.end_min_utc) : null;
    const minutesSinceEnd = end ? Math.floor((now.getTime() - end.getTime()) / 60000) : -1;
    const state = r.state as ReportState;
    const written = REPORT_WRITTEN.includes(state);
    // 이미 쓴 것은 더 깎이지 않는다. 안 쓴 채로 지난 시간만 본다 (D-R32).
    const penalty = written || minutesSinceEnd < 0 ? 0 : tierFor(minutesSinceEnd).amount;
    return {
      id: Number(r.id), serId: Number(r.ser_id), date: r.on_date, startMin: r.start_min,
      subKey: r.sub_key, kindKey: r.kind_key,
      teacherId: r.teacher_id ? Number(r.teacher_id) : null, teacherName: r.teacher_name,
      state, written, minutesSinceEnd, penalty,
      students: (r.students ?? []).map((s) => ({ id: Number(s.id), name: s.name, grade: s.grade })),
    };
  }

  async list(opts: { from?: string; to?: string; teacherId?: number; state?: string }): Promise<ReportRowDto[]> {
    const p: unknown[] = [];
    const c: string[] = ['1=1'];
    if (opts.from) { p.push(opts.from); c.push(`r.on_date >= $${p.length}`); }
    if (opts.to) { p.push(opts.to); c.push(`r.on_date <= $${p.length}`); }
    if (opts.teacherId) { p.push(opts.teacherId); c.push(`r.teacher_id = $${p.length}`); }
    if (opts.state) { p.push(opts.state); c.push(`r.state = $${p.length}`); }
    const rows = (await this.reps.query(ReportsService.sql(c.join(' AND ')), p)) as Row[];
    const now = new Date();
    return rows.map((r) => this.toRow(r, now));
  }

  /**
   * §47 안 쓴 리포트 — 강사별로 몇 건 밀렸는지.
   * 「지난 수업인데 안 썼다」만 센다. 앞으로의 수업은 밀린 것이 아니다.
   */
  async unwritten(teacherId?: number): Promise<UnwrittenDto> {
    const p: unknown[] = [];
    const c = [`r.state = 'none'`, `upper(o.span) < now()`];
    if (teacherId) { p.push(teacherId); c.push(`r.teacher_id = $${p.length}`); }
    const rows = (await this.reps.query(ReportsService.sql(c.join(' AND ')), p)) as Row[];
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
}
