/**
 * 시드 러너 — 위 데이터를 **실제 Postgres 행**으로 만든다.
 *
 * 프론트는 이 행들을 API 로만 본다. 목 데이터를 프론트에 두지 않는 이유가 이것이다 —
 * 진짜 데이터로 바꿀 때 프론트가 한 줄도 안 바뀐다 (자동 전이).
 */
import type { DataSource, QueryRunner } from 'typeorm';
import bcrypt from 'bcrypt';
import { KINDS, SUBS, ROOMS, ZACCS, STAFF, WAGES, RATES, TZGS, SEED_TODAY } from './base';
import { STUDENTS, ENROLLMENTS, LEADS } from './people';
import { SERS, UNAVS, STU_OUT, expand, resolveExceptions, applyExceptions } from './schedule';
import { buildReports, GUIDES, PNOTIS, LIBS, ISSUES } from './outputs';
import { INVOICES, INV_LINES, PAYMENTS, EXPENSES, PAYOUTS, STURATES } from './money';
import { REQS, CHREQS, NOTIS, CONSULTINGS, CONS_SESSIONS, MKTS, PLANS, MEETINGS, COMPLAINTS, SUGGESTIONS, REPORTS, TODOS } from './ops';

/** 시드가 건드리는 표 — 지울 때도 이 순서의 역순을 쓴다 */
export const SEEDED_TABLES = [
  'kind', 'sub', 'room', 'zacc', 'tzg', 'staff', 'wage', 'rate', 'sturate',
  'stu', 'enr', 'lead',
  'ser', 'ser_stu', 'ser_occ', 'exc', 'exc_stu_out', 'unav',
  'rep', 'rep_stu', 'guide', 'pnoti', 'lib', 'issue',
  'inv', 'inv_line', 'pay', 'expense', 'payout',
  'req', 'chreq', 'noti', 'cons', 'cons_stu', 'cons_sess',
  'mkt', 'plan', 'mtrec', 'mtattd', 'cpl', 'suggestion', 'rpt', 'todo',
] as const;

const PW = 'taco1234!';
const num = (v: number | null | undefined) => (v === undefined ? null : v);

/** span(tstzrange) — EXCLUDE 제약이 걸리는 컬럼. KST 를 UTC 로 적는다. */
function span(onDate: string, startMin: number, endMin: number): string {
  const at = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    const utc = new Date(`${onDate}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);
    return utc.toISOString();
  };
  return `[${at(startMin)},${at(endMin)})`;
}

async function insert(q: QueryRunner, table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  // 한 번에 넣는다 — 표마다 왕복하면 시드가 분 단위로 느려진다
  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const t = cols.map((c) => {
      values.push(r[c]);
      return `$${values.length}`;
    });
    return `(${t.join(', ')})`;
  });
  await q.query(`INSERT INTO ${table} (${quoted}) VALUES ${tuples.join(', ')}`, values);
  return rows.length;
}

export interface SeedResult { table: string; rows: number }

export async function runSeed(ds: DataSource, opts: { reset: boolean }): Promise<SeedResult[]> {
  const q = ds.createQueryRunner();
  await q.connect();
  await q.startTransaction();
  const done: SeedResult[] = [];
  const add = async (t: string, rows: Record<string, unknown>[]) => {
    done.push({ table: t, rows: await insert(q, t, rows) });
  };

  try {
    if (opts.reset) {
      // 역순으로 비운다. RESTART IDENTITY 로 id 도 되돌려 결정적으로 만든다.
      const list = [...SEEDED_TABLES].reverse().map((t) => `"${t}"`).join(', ');
      await q.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }

    // ── 기준 정보
    await add('kind', KINDS.map((k) => ({ key: k.key, name: k.name, color: k.color, cap: k.cap, grp: k.grp, rep: k.rep, rep_form: k.repForm, sort: k.sort })));
    await add('sub', SUBS.map((s, i) => ({ key: s.key, name: s.name, color: s.color, active: true, sort: i + 1 })));
    await add('room', ROOMS.map((r) => ({ id: r.id, branch: r.branch, name: r.name, capacity: r.capacity, active: true })));
    await add('tzg', TZGS);
    const secret = Buffer.from('seed-not-a-real-secret');
    await add('zacc', ZACCS.map((z) => ({ id: z.id, label: z.label, login_email: z.loginEmail, login_secret: secret, join_url: `https://zoom.us/j/${z.meetingId.replace(/ /g, '')}`, meeting_id: z.meetingId, meeting_pw_enc: secret, active: true })));

    const hash = await bcrypt.hash(PW, 10);
    await add('staff', STAFF.map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role, title: s.title, tz: 'Asia/Seoul', password_hash: hash, phone_verified: true, hired_on: s.hiredOn, active: true })));
    await add('wage', WAGES.map((w) => ({ staff_id: w.staffId, rate: w.rate, from_date: w.fromDate, approved_by: 1 })));
    await add('rate', RATES.map((r) => ({ kind_key: r.kindKey, sub_key: r.subKey, unit_price: r.unitPrice, from_date: r.fromDate })));
    await add('sturate', STURATES.map((r) => ({ student_id: r.studentId, kind_key: r.kindKey, unit_price: r.unitPrice, from_date: r.fromDate })));

    // ── 사람
    await add('stu', STUDENTS.map((s) => ({ id: s.id, name: s.name, grade: s.grade, school: s.school, target_exam: s.targetExam, started_on: s.startedOn, lang: s.lang })));
    await add('enr', ENROLLMENTS.map((e) => ({ student_id: e.studentId, kind_key: e.kindKey, sub_key: e.subKey, sessions: e.sessions, started_on: e.startedOn })));
    await add('lead', LEADS.map((l) => ({ id: l.id, student_id: l.studentId, name: l.name, school: l.school, owner_id: l.ownerId, stage: l.stage, stop_at: (l as { stopAt?: string }).stopAt ?? null, reason: (l as { reason?: string }).reason ?? null, created_at: `${l.createdAt}T00:00:00Z` })));

    // ── 일정
    await add('ser', SERS.map((s) => ({ id: s.id, kind_key: s.kindKey, sub_key: s.subKey, teacher_id: s.teacherId, room_id: s.roomId, mode: s.mode, start_min: s.startMin, end_min: s.endMin, rrule: `FREQ=WEEKLY;BYDAY=${s.days.join(',')}`, from_date: SEED_TODAY, title: s.title ?? null })));
    await add('ser_stu', SERS.flatMap((s) => s.students.map((st) => ({ ser_id: s.id, student_id: st }))));

    const raw = expand();
    // 예외는 「그 규칙이 실제로 만드는 회차」 위에만 올릴 수 있다.
    // 요일이 안 맞는 날짜를 적어 두면 조용히 아무 데도 안 붙는다 — 그래서 여기서 풀어 준다.
    const exceptions = resolveExceptions(raw);
    // 예외를 회차에 덮어씌운 뒤에 저장한다. 안 그러면 화면이 규칙의 강사·시간을 보여 준다.
    const occs = applyExceptions(raw, exceptions);
    const cancelKeys = new Set(exceptions.filter((e) => e.canceled).map((e) => `${e.serId}|${e.onDate}`));
    await add('ser_occ', occs.map((o) => ({
      ser_id: o.serId, on_date: o.onDate, teacher_id: o.teacherId, room_id: o.roomId,
      zacc_id: o.zaccId, canceled: o.canceled, span: span(o.onDate, o.startMin, o.endMin),
    })));
    await add('exc', exceptions.map((e) => ({ ser_id: e.serId, on_date: e.onDate, canceled: e.canceled, start_min: num((e as { startMin?: number }).startMin), end_min: num((e as { endMin?: number }).endMin), teacher_id: num((e as { teacherId?: number }).teacherId), reason: e.reason, by_id: e.byId, at: `${e.onDate}T00:00:00Z` })));
    // 그날만 빠진 학생 — 예외 id 가 필요하므로 exc 를 넣은 뒤에 붙인다
    const excRows = (await q.query("SELECT id, ser_id, to_char(on_date, 'YYYY-MM-DD') AS on_date FROM exc")) as Array<{ id: string; ser_id: string; on_date: string }>;
    const excId = new Map(excRows.map((r) => [`${r.ser_id}|${r.on_date}`, Number(r.id)]));
    const outRows: Array<Record<string, unknown>> = [];
    for (const so of STU_OUT) {
      const mine = occs.filter((x) => x.serId === so.serId && x.onDate < SEED_TODAY);
      const hit = mine[mine.length - so.nth];
      if (!hit) continue;
      let id = excId.get(`${so.serId}|${hit.onDate}`);
      if (!id) {
        const ins = (await q.query(
          'INSERT INTO exc (ser_id, on_date, canceled, reason, by_id, at) VALUES ($1,$2,false,$3,$4,$5) RETURNING id',
          [so.serId, hit.onDate, '이 회차만 빠짐', 4, `${hit.onDate}T00:00:00Z`],
        )) as Array<{ id: string }>;
        id = Number(ins[0].id);
        excId.set(`${so.serId}|${hit.onDate}`, id);
      }
      outRows.push({ exc_id: id, student_id: so.studentId });
    }
    await add('exc_stu_out', outRows);

    await add('unav', UNAVS.map((u) => ({ staff_id: u.staffId, cycle: u.cycle, dow: u.dow, start_min: u.startMin, end_min: u.endMin, reason: u.reason })));

    // ── 리포트 · 안내 · 교재
    const langOf = (id: number) => STUDENTS.find((s) => s.id === id)?.lang ?? 'ko';
    const reps = buildReports(occs.filter((o) => !cancelKeys.has(`${o.serId}|${o.onDate}`)), langOf);
    await add('rep', reps.map((r) => ({ ser_id: r.serId, on_date: r.onDate, teacher_id: r.teacherId, kind_key: r.kindKey, lang: r.lang, state: r.state, body: JSON.stringify(r.body), written_at: r.writtenAt, submitted_at: r.submittedAt, reviewed_at: r.reviewedAt, reviewer_id: r.reviewerId, reject_reason: r.rejectReason })));
    // 리포트 id 는 방금 넣은 순서대로다 — 학생을 REP_STU 로 붙인다
    // on_date 를 그대로 받으면 드라이버가 Date 로 바꿔 키가 어긋난다 — 문자열로 받는다
    const repIds = (await q.query("SELECT id, ser_id, to_char(on_date, 'YYYY-MM-DD') AS on_date FROM rep ORDER BY id")) as Array<{ id: string; ser_id: string; on_date: string }>;
    const keyOf = (ser: unknown, d: unknown) => `${ser}|${d}`;
    const idBy = new Map(repIds.map((r) => [keyOf(r.ser_id, r.on_date), Number(r.id)]));
    await add('rep_stu', reps.flatMap((r) => {
      const id = idBy.get(keyOf(r.serId, r.onDate));
      return id ? r.students.map((sid) => ({ rep_id: id, student_id: sid, deliver: true })) : [];
    }));
    await add('guide', GUIDES.map((g) => ({ ser_id: g.serId, student_id: g.studentId, teacher_id: g.teacherId, reason: g.reason, state: g.state, due_on: g.dueOn })));
    await add('pnoti', PNOTIS.map((p) => ({ ser_id: p.serId, on_date: p.onDate, student_id: p.studentId, channel: p.channel, body: p.body, sent_at: p.sentAt ? `${p.sentAt}T09:00:00Z` : null })));
    await add('lib', LIBS.map((l) => ({ id: l.id, code: l.code, title: l.title, sub_key: l.subKey, level: l.level, pages: l.pages, se_te: l.seTe })));
    await add('issue', ISSUES.map((i) => ({ lib_id: i.libId, student_id: i.studentId, issued_on: i.issuedOn })));

    // ── 회계
    await add('inv', INVOICES.map((i) => ({ id: i.id, student_id: i.studentId, year_month: i.yearMonth, inv_type: i.invType, title: i.title, amount: i.amount, state: i.state, issued_on: i.issuedOn, due_on: i.dueOn, paid_amount: i.paidAmount, paid_at: (i as { paidAt?: string }).paidAt ? `${(i as { paidAt?: string }).paidAt}T00:00:00Z` : null, created_by: 2 })));
    await add('inv_line', INV_LINES.map((l) => ({ inv_id: l.invId, sub_key: l.subKey, label: l.label, count: l.count, unit_price: l.unitPrice, amount: l.count * l.unitPrice, seq: l.seq })));
    await add('pay', PAYMENTS.map((p) => ({ inv_id: p.invId, student_id: p.studentId, amount: p.amount, paid_on: p.paidOn, method: p.method, entered_by: p.enteredBy, entered_at: `${p.paidOn}T00:00:00Z`, confirmed_by: p.confirmedBy, confirmed_at: `${p.paidOn}T01:00:00Z` })));
    await add('expense', EXPENSES.map((e) => ({ spend_on: e.spendOn, category: e.category, merchant: e.merchant, purpose: e.purpose, requested_amount: num((e as { requestedAmount?: number }).requestedAmount), amount: e.amount, receipt_url: e.receiptUrl, requester_id: e.requesterId, state: e.state, reviewer_id: e.reviewerId })));
    await add('payout', PAYOUTS.map((p) => ({ staff_id: p.staffId, year_month: p.yearMonth, hours: p.hours, gross: p.gross, late_rep_cut: p.lateRepCut, late_cls_cut: 0, income_tax: p.incomeTax, local_tax: p.localTax, net: p.net, state: p.state, confirmed_by: p.confirmedBy })));

    // ── 운영
    await add('req', REQS.map((r) => ({ staff_id: r.staffId, req_type: r.reqType, payload: JSON.stringify(r.payload), state: r.state, resolved_by: num((r as { resolvedBy?: number }).resolvedBy), reject_reason: (r as { rejectReason?: string }).rejectReason ?? null, created_at: `${r.createdAt}T00:00:00Z` })));
    await add('chreq', CHREQS.map((c) => ({ ser_id: c.serId, on_date: c.onDate, req_type: c.reqType, payload: JSON.stringify(c.payload), reason: c.reason, state: c.state, by_id: c.byId, resolved_by: num((c as { resolvedBy?: number }).resolvedBy), apply_all: c.applyAll, created_at: `${c.createdAt}T00:00:00Z` })));
    await add('noti', NOTIS.map((n) => ({ to_id: n.toId, from_id: n.fromId, body: n.body, link: n.link, read_at: (n as { readAt?: string }).readAt ? `${(n as { readAt?: string }).readAt}T00:00:00Z` : null, created_at: `${n.createdAt}T00:00:00Z` })));
    await add('cons', CONSULTINGS.map((c) => ({ id: c.id, cons_type: c.consType, stage: c.stage, contract_step: c.contractStep, amount: c.amount, sessions: c.sessions, end_on: c.endOn, owner_id: c.ownerId, share: c.share })));
    await add('cons_stu', CONSULTINGS.flatMap((c) => c.students.map((s) => ({ cons_id: c.id, student_id: s }))));
    await add('cons_sess', CONS_SESSIONS.map((s) => ({ cons_id: s.consId, seq: s.seq, on_date: s.onDate, who: s.who, what: s.what, why: s.why, how: s.how })));
    await add('mkt', MKTS.map((m) => ({ channel: m.channel, item: m.item, url: m.url, result: JSON.stringify(m.result), on_date: m.onDate })));
    await add('plan', PLANS.map((p) => ({ id: p.id, title: p.title, stage: p.stage, goal: p.goal, research: p.research, ask: p.ask, due_on: p.dueOn, owner_id: p.ownerId })));
    await add('mtrec', MEETINGS.map((m) => ({ id: m.id, mt_type: m.mtType, title: m.title, on_date: m.onDate, minutes: m.minutes })));
    await add('mtattd', MEETINGS.flatMap((m) => m.attendees.map((a) => ({ mt_id: m.id, staff_id: a, confirmed: m.minutes !== null }))));
    await add('cpl', COMPLAINTS.map((c) => ({ area: c.area, student_id: c.studentId, stage: c.stage, body: c.body, action: (c as { action?: string }).action ?? null, result: (c as { result?: string }).result ?? null, teacher_changed: c.teacherChanged, owner_id: c.ownerId, created_at: `${c.createdAt}T00:00:00Z` })));
    await add('suggestion', SUGGESTIONS.map((s) => ({ staff_id: s.staffId, category: s.category, body: s.body, state: s.state, reply: (s as { reply?: string }).reply ?? null, reply_by: num((s as { replyBy?: number }).replyBy), reply_at: (s as { replyAt?: string }).replyAt ? `${(s as { replyAt?: string }).replyAt}T00:00:00Z` : null, created_at: `${s.createdAt}T00:00:00Z` })));
    await add('rpt', REPORTS.map((r) => ({ rpt_type: r.rptType, on_date: r.onDate, memo: JSON.stringify(r.memo), state: r.state, sent_at: (r as { sentAt?: string }).sentAt ? `${(r as { sentAt?: string }).sentAt}T00:00:00Z` : null, reviewed_at: (r as { reviewedAt?: string }).reviewedAt ? `${(r as { reviewedAt?: string }).reviewedAt}T00:00:00Z` : null })));
    await add('todo', TODOS.map((t) => ({ title: t.title, from_id: t.fromId, to_id: t.toId, due_on: t.dueOn, done: t.done, src: t.src, mt_id: num((t as { mtId?: number }).mtId), plan_id: num((t as { planId?: number }).planId) })));

    // 손으로 넣은 id 뒤로 시퀀스를 밀어 둔다 — 안 하면 다음 INSERT 가 충돌한다
    for (const t of ['room', 'zacc', 'staff', 'stu', 'lead', 'ser', 'lib', 'inv', 'cons', 'plan', 'mtrec']) {
      await q.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${t}), 1))`);
    }

    await q.commitTransaction();
    return done;
  } catch (e) {
    await q.rollbackTransaction();
    throw e;
  } finally {
    await q.release();
  }
}
