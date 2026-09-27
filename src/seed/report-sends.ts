/** @file-guide
 * 목적: report-sends.ts — seedReportSends (seed)
 * 책임/재사용: §48 보낸 내역 · F3 파일 권한 e2e 를 위한 **리포트 발송 이력 표본**을 시드 DB 에만 넣는다(가짜 발송자 · 시험 데이터).
 *   고르는 규칙은 하루 발송과 같다 — 그 학생의 그날 리포트가 **전부 승인**된 묶음만(`reportDeliveryIssue` 의 문).
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { createHash } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { reportPlainText, reportPngFileName, type ReportBody } from '../lib/rules';
import { END_MIN, START_MIN } from '../lib/sql';
import { REPORT_DATE_SQL } from '../modules/reports/report-sql';
import type { SeedResult } from './index';

/** 발송 표본의 파일 id 는 교재 파일 뒤에서 시작한다(`file` 은 손으로 넣은 id 를 쓴다 · 끝에 시퀀스를 민다) */
const FILE_ID_BASE = 900;
/** 가짜 발송자 — 시드 관리자(2). 실제 외부 발송은 없다(channel = blob · 보존만) */
const SENDER_ID = 2;
/** 표본 수 — 최초 발송 둘 + 첫 것의 재발송 하나 */
const SAMPLE_GROUPS = 2;

/** 1×1 투명 PNG — 서명(8바이트)까지 진짜 PNG 다. 화면의 「파일 N장 보관」 · 파일 권한 판정만 본다 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 시드가 늘 같은 키를 쓰도록 — 무작위 UUID 를 쓰면 `--reset` 마다 다른 원장이 된다 */
function seedUuid(label: string): string {
  const h = createHash('sha256').update(`taco-seed-rsend:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface Candidate {
  student_id: string; student_name: string; grade: string | null; date: string;
  rep_id: string; subject_name: string; start_min: number | null; end_min: number | null; body: unknown;
}

function bodyOf(raw: unknown): ReportBody {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    content: typeof v.content === 'string' ? v.content : '',
    progress: typeof v.progress === 'string' ? v.progress : '',
    homework: typeof v.homework === 'string' ? v.homework : '',
  };
}

/**
 * 리포트 · REP_STU 를 넣은 **뒤**에 부른다. 오늘보다 앞선 날 중 가장 최근의 「전부 승인된 학생 하루」 두 묶음을 골라
 * RSEND(최초) + PDFLOG(장마다 `rep_id`) + FILE(report-png) 을 넣고, 첫 묶음은 한 번 다시 보낸다(`source_send_id`).
 */
export async function seedReportSends(q: QueryRunner, today: string): Promise<SeedResult[]> {
  const rows = await q.query(
    `WITH per AS (
       SELECT x.student_id, ${REPORT_DATE_SQL} AS date, bool_and(r.state = 'ok') AS all_ok
         FROM rep r
         JOIN rep_stu x ON x.rep_id = r.id AND x.deliver
         JOIN ser s ON s.id = r.ser_id
         JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key) AND k.rep
         LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
        WHERE NOT COALESCE(o.canceled, false)
        GROUP BY x.student_id, ${REPORT_DATE_SQL}
     ), picked AS (
       SELECT student_id, date FROM per
        WHERE all_ok AND date < $1::date
        ORDER BY date DESC, student_id
        LIMIT $2
     )
     SELECT st.id AS student_id, st.name AS student_name, st.grade, to_char(p.date, 'YYYY-MM-DD') AS date,
            r.id AS rep_id, COALESCE(sb.name, s.title, k.name) AS subject_name,
            ${START_MIN} AS start_min, ${END_MIN} AS end_min, r.body
       FROM picked p
       JOIN rep_stu x ON x.student_id = p.student_id AND x.deliver
       JOIN rep r ON r.id = x.rep_id
       JOIN ser s ON s.id = r.ser_id
       JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key) AND k.rep
       LEFT JOIN sub sb ON sb.key = s.sub_key
       LEFT JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
       JOIN stu st ON st.id = p.student_id
      WHERE ${REPORT_DATE_SQL} = p.date AND NOT COALESCE(o.canceled, false)
      ORDER BY p.date DESC, st.id, start_min NULLS LAST, r.id`,
    [today, SAMPLE_GROUPS],
  ) as Candidate[];

  const groups = new Map<string, Candidate[]>();
  for (const row of rows) {
    const key = `${row.student_id}|${row.date}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let fileId = FILE_ID_BASE;
  let files = 0;
  let sends = 0;
  let logs = 0;
  let first: { id: number; studentId: number; date: string; repIds: number[]; body: string } | null = null;
  for (const [n, group] of [...groups.values()].entries()) {
    const head = group[0];
    const repFiles = group.map((row) => {
      const body = bodyOf(row.body);
      const base = {
        date: row.date, studentName: row.student_name, studentGrade: row.grade,
        subjectName: row.subject_name, startMin: row.start_min === null ? null : Number(row.start_min),
      };
      return {
        repId: Number(row.rep_id),
        name: reportPngFileName(base),
        text: reportPlainText({ ...base, endMin: row.end_min === null ? null : Number(row.end_min), body }),
      };
    });
    for (const file of repFiles) {
      fileId += 1;
      await q.query(
        `INSERT INTO file (id, kind, name, mime, bytes, sha256, data, uploaded_by)
         VALUES ($1, 'report-png', $2, 'image/png', $3, $4, $5, $6)`,
        [fileId, file.name, TINY_PNG.length, createHash('sha256').update(TINY_PNG).digest('hex'), TINY_PNG, SENDER_ID],
      );
      (file as { fileId?: number }).fileId = fileId;
      files += 1;
    }
    const body = repFiles.map((file) => file.text).join('\n\n────────\n\n');
    const repIds = repFiles.map((file) => file.repId);
    const [sent] = await q.query(
      `INSERT INTO rsend (student_id, on_date, rep_ids, channel, body, sent_by, request_key, source_send_id, sent_at)
       VALUES ($1, $2, $3::jsonb, 'blob', $4, $5, $6, NULL, ($2::date + interval '1 day 10 hours') AT TIME ZONE 'Asia/Seoul')
       RETURNING id`,
      [Number(head.student_id), head.date, JSON.stringify(repIds), body, SENDER_ID, seedUuid(`first-${n}`)],
    ) as Array<{ id: string }>;
    sends += 1;
    for (const file of repFiles) {
      await q.query(
        `INSERT INTO pdflog (kind, ref_id, file_url, rep_id) VALUES ('report_png', $1, $2, $3)`,
        [Number(sent.id), `/files/${(file as { fileId?: number }).fileId}`, file.repId],
      );
      logs += 1;
    }
    if (!first) first = { id: Number(sent.id), studentId: Number(head.student_id), date: head.date, repIds, body };
  }

  // 첫 묶음의 재발송 한 줄 — 같은 본문 · 같은 파일 주소(§48 「다시 보내기」가 만드는 모양 그대로)
  if (first) {
    const [again] = await q.query(
      `INSERT INTO rsend (student_id, on_date, rep_ids, channel, body, sent_by, request_key, source_send_id, sent_at)
       VALUES ($1, $2, $3::jsonb, 'blob', $4, $5, $6, $7, ($2::date + interval '2 days 9 hours') AT TIME ZONE 'Asia/Seoul')
       RETURNING id`,
      [first.studentId, first.date, JSON.stringify(first.repIds), first.body, SENDER_ID, seedUuid('resend-0'), first.id],
    ) as Array<{ id: string }>;
    sends += 1;
    const copied = await q.query(
      `INSERT INTO pdflog (kind, ref_id, file_url, rep_id)
       SELECT 'report_png', $1, file_url, rep_id FROM pdflog WHERE kind = 'report_png' AND ref_id = $2
       RETURNING id`,
      [Number(again.id), first.id],
    ) as unknown[];
    logs += copied.length;
  }

  return [
    { table: 'file', rows: files },
    { table: 'rsend', rows: sends },
    { table: 'pdflog', rows: logs },
  ];
}
