/** @file-guide
 * 목적: index.ts — SEEDED_TABLES, SeedResult, runSeed (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 시드 러너 — 위 데이터를 **실제 Postgres 행**으로 만든다.
 *
 * 프론트는 이 행들을 API 로만 본다. 목 데이터를 프론트에 두지 않는 이유가 이것이다 —
 * 진짜 데이터로 바꿀 때 프론트가 한 줄도 안 바뀐다 (자동 전이).
 */
import { createHash } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import bcrypt from 'bcryptjs';
import { KINDS, SUBS, ROOMS, ZACCS, STAFF, WAGES, RATES, TZGS, SEED_TODAY, rel } from './base';
import { addD } from '../lib/recurrence';
import { isWrittenDbState } from '../lib/rules';
// 회차 · 리포트 칸은 쓰기 경로와 **같은 두 함수**로 편다 (N-49) — 시드가 제품이 만들 수 없는 행을 넣지 않게
import { horizon, project } from '../modules/schedule/schedule.project';
import { loadState } from '../modules/schedule/schedule.state.repo';
import { invoiceLines, linesTotal } from '../modules/accounting/invoice-lines';
import { invoiceTitle } from '../modules/accounting/accounting.dto';
import { STUDENTS, ENROLLMENTS, LEADS, LEAD_DIAGS, LEAD_PLANS, LEAD_APPTS } from './people';
import { SERS, UNAVS, STU_OUT, RANGE_FROM, RANGE_TO, expand, resolveExceptions, applyExceptions, occurrenceInMonth, serFromDate, serRrule } from './schedule';
import { BOOK_FILES, BOOK_HISTORY, BOOK_VERSIONS, buildReports, GUIDES, PNOTIS, LIBS, ISSUES } from './outputs';
import { INVOICES, INV_LINES, PAYMENTS, EXPENSES, PAYOUTS, STURATES, CARRY_BLOCKED } from './money';
import { GUARDIANS } from './guardians';
import { seedReportSends } from './report-sends';
import { REQS, CHREQS, GPAPACKS, NOTIS, CONSULTINGS, CONS_PICKS, CONS_SESSIONS, MKTS, MFBS, PLANS, MEETINGS, COMPLAINTS, SUGGESTIONS, REPORTS, TODOS , CONS_ITEMS, CONS_PAYS, DIAGS, GPASVCS, GPA_CYCLES, GPA_ALLOCS, GPA_USES } from './ops';
import { LEAD_CARE_FIRST } from './ops';
import { seedStudentCatalogV1 } from '../migrations/data/student-catalog-v1';

/**
 * `--reset` 이 비우는 표 — 넣을 때의 이 순서를 **역순으로** 지운다.
 *
 * 「시드가 넣는 표」보다 넓다. **앱이 쓰는 표는 시드가 안 넣어도 여기 있어야 한다** —
 * 없으면 `--reset` 뒤에도 그 표의 행이 살아남아 「깨끗한 dev DB」가 거짓이 된다.
 * 실제로 겪었다: 브라우저 QA 로 만든 `vers`·`hist` 행이 `--reset` 을 넘기고 남아
 * 다음 QA 가 「이미 있습니다」로 막혔다 (C52).
 *
 * 새 표에 쓰기를 붙이면 여기에도 한 줄을 늘린다. 안 늘렸는지는
 * `seed-reset-covers-writes` 회귀가 본다.
 */
export const SEEDED_TABLES = [
  'kind', 'sub', 'room', 'zacc', 'tzg', 'staff', 'wage', 'rate', 'sturate',
  'stu', 'enr', 'lead',
  // ST1-b1 사용자가 추가한 학교만 reset. 국가/시간대/학년은 공유 사전이라 truncate하지 않는다.
  'school',
  // ST1-b2 기간·감사: dev --reset은 STU와 함께 두 원장을 명시적으로만 초기화한다.
  // 운영 전환 reset과 무관하다. 여기서 빠져도 STU TRUNCATE CASCADE가 조용히 지우므로 목록에 드러낸다.
  'stu_profile_audit', 'stu_profile_period',
  // 줌 배정 정본(`zassign`)은 온라인 규칙에 시드가 넣는다(N-49 · W11) — 회차의 계정(`ser_occ.zacc_id`)은 그 투영이다
  'ser', 'ser_stu', 'ser_occ', 'exc', 'exc_stu_out', 'zassign', 'unav',
  'rep', 'rep_stu', 'guide', 'pnoti', 'lib', 'issue',
  // N-54 주간 묶음 총평(W11 · R2) — 시드는 안 넣는다(사람이 쓴 글만 둔다) · 앱이 쓰므로 비운다
  'wrep',
  'inv', 'inv_line', 'inv_installment', 'pay', 'expense', 'payout', 'carry',
  'req', 'chreq', 'gpapack', 'gpapack_student', 'gpapack_lib', 'noti', 'cons', 'cons_stu', 'cons_pick', 'cons_sess', 'cons_item', 'cons_pay',
  'cons_file', 'cons_feedback', 'cons_event', 'diag', 'lead_diag',
  // wave3 g3 (23-15 · 23-16) — 상담 배치안 초안 · 2차/진단 일정
  'lead_plan', 'lead_appt',
  'gpasvc', 'gpa_cycle', 'gpa_alloc', 'gpa_use',
  'mkt', 'mfb', 'plan', 'mtrec', 'mtattd', 'cpl', 'suggestion', 'rpt', 'todo',
  // W11 — 기획 지정 공개(N-72) · 대표 보고 영역 담당(N-81) · 시드는 안 넣는다(담당은 대표가 정한다 · 이름을 지어 넣지 않는다)
  'plan_pick', 'exec_area_owner',
  // DQ3 — 학생 보호자 (가짜 연락처만)
  'guardian',
  'guardian_contact',
  // 시드는 안 넣지만 앱이 쓴다 — 넣지 않아도 **비우기는 해야 한다**
  'gtpl', 'vers', 'hist', 'file', 'stu_pause', 'month_close',
  // W11 M2 — 정산 근거 줄 · 가산 규칙 · 회계 비공개 스위치 · 인수인계 메모 (N-36 · N-93 · N-94) — 시드는 안 넣는다(규칙 · 스위치는 대표가 정한다)
  'payout_line', 'payout_bonus_rule', 'acct_privacy', 'note',
  // 기록만 쌓이는 표들 — 안 비우면 dev DB 에 옛 QA 흔적이 끝없이 남는다
  'att', 'att_late', 'lead_stage_log', 'lead_touch', 'log', 'pdflog', 'rsend', 'zlog',
  // DQ3 보호자 발송 원장 — 시드는 안 넣는다(보낸 적 없는 발송을 지어내지 않는다)
  'guardian_send',
  // W8 첫 설정 인증 코드 — 시드는 안 넣는다(보낸 적 없는 코드를 지어내지 않는다)
  'auth_code',
] as const;

const PW = 'taco1234!';
const num = (v: number | null | undefined) => (v === undefined ? null : v);

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

    // migration에도 든 버전 고정 기본 사전. 기존 표시명·활성 상태·sort는 절대 덮지 않는다.
    // 새 학교는 가짜로 만들지 않는다(legacy STU.school의 동일성/재학 날짜는 미상).
    const catalog = await seedStudentCatalogV1(q);
    done.push({ table: 'country', rows: catalog.country });
    done.push({ table: 'country_timezone', rows: catalog.countryTimezone });
    done.push({ table: 'education_grade', rows: catalog.educationGrade });

    // ── 기준 정보
    await add('kind', KINDS.map((k) => ({ key: k.key, name: k.name, color: k.color, cap: k.cap, grp: k.grp, rep: k.rep, rep_form: k.repForm, sort: k.sort })));
    await add('sub', SUBS.map((s, i) => ({ key: s.key, name: s.name, color: s.color, active: true, sort: i + 1 })));
    await add('room', ROOMS.map((r) => ({ id: r.id, branch: r.branch, name: r.name, capacity: r.capacity, active: true })));
    await add('tzg', TZGS);
    const secret = Buffer.from('seed-not-a-real-secret');
    await add('zacc', ZACCS.map((z) => ({ id: z.id, label: z.label, login_email: z.loginEmail, login_secret: secret, join_url: `https://zoom.us/j/${z.meetingId.replace(/ /g, '')}`, meeting_id: z.meetingId, meeting_pw_enc: secret, active: true })));

    const hash = await bcrypt.hash(PW, 10);
    // 아이디는 이메일과 같게 둔다 — 운영의 옛 계정이 옮겨 온 모양과 같다(W10 · 아이디 형식은 자유라 이메일 모양도 아이디다)
    await add('staff', STAFF.map((s) => ({ id: s.id, name: s.name, login_id: s.email, email: s.email, role: s.role, title: s.title, tz: 'Asia/Seoul', password_hash: hash, phone_verified: true, hired_on: s.hiredOn, active: true })));
    await add('wage', WAGES.map((w) => ({ staff_id: w.staffId, rate: w.rate, from_date: w.fromDate, approved_by: 1 })));
    await add('rate', RATES.map((r) => ({ kind_key: r.kindKey, heads: (r as { heads?: number }).heads ?? 1, sub_key: r.subKey, unit_price: r.unitPrice, from_date: r.fromDate })));
    await add('sturate', STURATES.map((r) => ({ student_id: r.studentId, kind_key: r.kindKey, unit_price: r.unitPrice, from_date: r.fromDate, reason: r.reason, by_id: r.byId })));

    // ── 사람
    await add('stu', STUDENTS.map((s) => ({ id: s.id, name: s.name, grade: s.grade, school: s.school, target_exam: s.targetExam, started_on: rel(s.startedOn), lang: s.lang })));
    await add('enr', ENROLLMENTS.map((e) => ({ student_id: e.studentId, kind_key: e.kindKey, sub_key: e.subKey, sessions: e.sessions, started_on: rel(e.startedOn) })));
    await add('lead', LEADS.map((l) => ({ id: l.id, student_id: l.studentId, name: l.name, school: l.school, owner_id: l.ownerId, stage: l.stage, stop_at: (l as { stopAt?: string }).stopAt ?? null, reason: (l as { reason?: string }).reason ?? null, source: (l as { source?: string }).source ?? null, created_at: `${rel(l.createdAt)}T00:00:00Z`,
      // W11 · N-87 실패 당시 단계 · N-86 첫 실제 수업일(사후 관리 기준일)
      fail_from: (l as { failFrom?: string }).failFrom ?? null, first_lesson_on: LEAD_CARE_FIRST[l.id] ?? null })));

    // ── 일정
    // 반복 규칙은 가장 이른 지난 회차(3주 전)에서 시작한다 — 지난 회차도 규칙이 만든다 (N-49 · schedule.serFromDate)
    await add('ser', SERS.map((s) => ({ id: s.id, kind_key: s.kindKey, sub_key: s.subKey, teacher_id: s.teacherId, room_id: s.roomId, mode: s.mode, start_min: s.startMin, end_min: s.endMin, rrule: serRrule(s), from_date: serFromDate(s), title: s.title ?? null })));
    await add('ser_stu', SERS.flatMap((s) => s.students.map((st) => ({ ser_id: s.id, student_id: st }))));

    const raw = expand();
    // 예외는 「그 규칙이 실제로 만드는 회차」 위에만 올릴 수 있다.
    // 요일이 안 맞는 날짜를 적어 두면 조용히 아무 데도 안 붙는다 — 그래서 여기서 풀어 준다.
    const exceptions = resolveExceptions(raw);
    // 예외를 얹은 회차 — **표에 넣지 않는다**(표는 아래 제품 투영이 만든다 · N-49). 그날만 빠짐 · 리포트 상태가 설 날짜를 고르는 데만 쓴다
    const occs = applyExceptions(raw, exceptions);
    const cancelKeys = new Set(exceptions.filter((e) => e.canceled).map((e) => `${e.serId}|${e.onDate}`));
    await add('exc', exceptions.map((e) => ({ ser_id: e.serId, on_date: e.onDate, canceled: e.canceled, start_min: num((e as { startMin?: number }).startMin), end_min: num((e as { endMin?: number }).endMin), teacher_set: (e as { teacherId?: number }).teacherId !== undefined, teacher_id: num((e as { teacherId?: number }).teacherId), room_set: false, reason: e.reason, by_id: e.byId, at: `${e.onDate}T00:00:00Z` })));
    // 그날만 빠진 학생 — 예외 id 가 필요하므로 exc 를 넣은 뒤에 붙인다
    const excRows = (await q.query("SELECT id, ser_id, to_char(on_date, 'YYYY-MM-DD') AS on_date FROM exc")) as Array<{ id: string; ser_id: string; on_date: string }>;
    const excId = new Map(excRows.map((r) => [`${r.ser_id}|${r.on_date}`, Number(r.id)]));
    const outs: Array<{ serId: number; onDate: string; studentId: number }> = [];
    for (const so of STU_OUT) {
      const mine = occs.filter((x) => x.serId === so.serId && x.onDate < SEED_TODAY);
      const hit = mine[mine.length - so.nth];
      if (hit) outs.push({ serId: so.serId, onDate: hit.onDate, studentId: so.studentId });
    }
    // F12 「이월 막힘」 표본의 결강 — 완납 청구서의 달 안의 회차 하나 (money.CARRY_BLOCKED)
    outs.push({
      serId: CARRY_BLOCKED.serId, studentId: CARRY_BLOCKED.studentId,
      onDate: occurrenceInMonth(occs, CARRY_BLOCKED.serId, CARRY_BLOCKED.month),
    });
    const outRows: Array<Record<string, unknown>> = [];
    for (const o of outs) {
      let id = excId.get(`${o.serId}|${o.onDate}`);
      if (!id) {
        const ins = (await q.query(
          'INSERT INTO exc (ser_id, on_date, canceled, reason, by_id, at) VALUES ($1,$2,false,$3,$4,$5) RETURNING id',
          [o.serId, o.onDate, '이 회차만 빠짐', 4, `${o.onDate}T00:00:00Z`],
        )) as Array<{ id: string }>;
        id = Number(ins[0].id);
        excId.set(`${o.serId}|${o.onDate}`, id);
        // 요약의 행 수가 표와 같게 — 그날만 빠짐이 새로 연 예외도 exc 행이다
        done.find((r) => r.table === 'exc')!.rows += 1;
      }
      outRows.push({ exc_id: id, student_id: o.studentId });
    }
    await add('exc_stu_out', outRows);

    /* 줌 배정 정본 — 온라인 규칙마다 규칙 대상 고정 배정 한 줄(`ZoomService.assignIn` 이 쓰는 모양 그대로 · C48).
       회차의 계정(`ser_occ.zacc_id`)은 아래 투영이 이 정본에서 읽는다. 전에는 투영에만 적혀 있어 그 수업에 첫 쓰기
       (방식 전환 포함)를 하면 재투영이 계정을 비웠다 (N-49 · W11). 배정 이력(zlog)은 계정 화면의 몫이라 넣지 않는다. */
    await add('zassign', SERS.filter((s) => s.mode === 'online' && s.zaccId !== null)
      .map((s) => ({ ser_id: s.id, zacc_id: s.zaccId, fixed: true })));

    /* 회차 투영 — 쓰기 경로와 **같은 두 함수**(`loadState` → `project`)다 (N-49). 손으로 넣던 `ser_occ` 를 걷었다.
       투영은 회차와 함께 리포트 칸(끝난 회차 none · 앞으로 plan)과 그날 명단(REP_STU — 그날만 빠진 학생 제외)까지 편다.
       기간은 쓰기 경로의 `horizon()` 이다. 기준일을 못 박은 재현(SEED_TODAY)이 그 밖이면 시드의 3주까지 넓힌다 — 오늘 시드는 그대로 `horizon()`. */
    const serIds = SERS.map((s) => s.id);
    const h = horizon();
    const range = { from: RANGE_FROM < h.from ? RANGE_FROM : h.from, to: RANGE_TO > h.to ? RANGE_TO : h.to };
    done.push({ table: 'ser_occ', rows: await project(q, await loadState(q, serIds), serIds, range) });

    await add('unav', UNAVS.map((u) => ({ staff_id: u.staffId, on_date: u.onDate, dow: new Date(`${u.onDate}T00:00:00Z`).getUTCDay(), start_min: u.startMin, end_min: u.endMin, reason: u.reason })));

    // ── 리포트 · 안내 · 교재
    /* 리포트 칸은 위 투영이 냈다. 시드는 **지난 회차 중 제출된 것만** 그 칸에 덮는다(승인 대기 · 승인 · 반려) —
       제품의 차례와 같다: 칸이 서고(명단이 붙고) → 쓰고 제출하면 그 순간의 명단이 굳는다. 안 쓴 칸(none · plan)은 투영이 시각으로 이미 정했다.
       붙을 칸이 없으면 던진다 — 조용히 빠지지 않게. */
    const langOf = (id: number) => STUDENTS.find((s) => s.id === id)?.lang ?? 'ko';
    const submitted = buildReports(occs.filter((o) => !cancelKeys.has(`${o.serId}|${o.onDate}`)), langOf)
      .filter((r) => isWrittenDbState(r.state));
    if (submitted.length) {
      const vals: unknown[] = [];
      const tuples = submitted.map((r) => {
        const b = vals.length;
        vals.push(r.serId, r.onDate, r.state, JSON.stringify(r.body), r.writtenAt, r.submittedAt, r.reviewedAt, r.reviewerId, r.rejectReason);
        return `($${b + 1}::bigint, $${b + 2}::date, $${b + 3}::rep_state_t, $${b + 4}::jsonb, $${b + 5}::timestamptz, $${b + 6}::timestamptz, $${b + 7}::timestamptz, $${b + 8}::bigint, $${b + 9}::text)`;
      });
      const [, hit] = (await q.query(
        `UPDATE rep r SET state = v.state, body = v.body, written_at = v.written_at, submitted_at = v.submitted_at,
                          reviewed_at = v.reviewed_at, reviewer_id = v.reviewer_id, reject_reason = v.reject_reason
           FROM (VALUES ${tuples.join(', ')})
             AS v(ser_id, on_date, state, body, written_at, submitted_at, reviewed_at, reviewer_id, reject_reason)
          WHERE r.ser_id = v.ser_id AND r.on_date = v.on_date`,
        vals,
      )) as [unknown, number];
      if (hit !== submitted.length) throw new Error(`시드: 제출한 리포트 ${submitted.length}건 중 ${hit}건만 투영된 리포트 칸에 붙었습니다`);
    }
    for (const t of ['rep', 'rep_stu']) {
      const [{ n }] = (await q.query(`SELECT count(*)::int AS n FROM ${t}`)) as Array<{ n: number }>;
      done.push({ table: t, rows: n });
    }
    await add('guide', GUIDES.map((g) => ({ ser_id: g.serId, student_id: g.studentId, teacher_id: g.teacherId, reason: g.reason, state: g.state, body: g.body, due_on: g.dueOn })));
    await add('pnoti', PNOTIS.map((p) => ({ ser_id: p.serId, on_date: p.onDate, student_id: p.studentId, channel: p.channel, body: p.body, sent_at: p.sentAt ? `${p.sentAt}T09:00:00Z` : null })));
    await add('lib', LIBS.map((l) => ({ id: l.id, code: l.code, title: l.title, sub_key: l.subKey, level: l.level, grade: l.grade, pages: l.pages, se_te: l.seTe })));
    await add('file', BOOK_FILES.map((file) => {
      const data = Buffer.from(file.body, 'utf8');
      return {
        id: file.id, kind: file.kind, name: file.name, mime: 'application/pdf', bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'), data, uploaded_by: 2,
      };
    }));
    await add('vers', BOOK_VERSIONS.map((version) => ({
      id: version.id, lib_id: version.libId, edition: version.edition, file_url: null,
      from_date: addD(SEED_TODAY, version.fromOffset), se_file_id: version.seFileId, te_file_id: version.teFileId,
    })));
    const currentVersByLib = new Map<number, number>(BOOK_VERSIONS.filter((version) => version.fromOffset <= 0).map((version) => [version.libId, version.id]));
    await add('issue', ISSUES.map((i, n) => ({
      lib_id: i.libId, vers_id: currentVersByLib.get(i.libId) ?? null, student_id: i.studentId,
      issued_on: i.issuedOn, returned_on: n === 7 ? addD(i.issuedOn, 30) : null, state: n === 7 ? 'returned' : 'ok',
      // §38 진도 퍼센트의 원장은 쪽수다. 서로 다른 값과 null 분기를 모두 데모한다.
      progress_page: n % 5 === 0 ? null : Math.max(1, Math.round((LIBS.find((l) => l.id === i.libId)?.pages ?? 1) * (0.28 + (n % 4) * 0.13))),
    })));
    await add('hist', BOOK_HISTORY.map((history, n) => ({
      entity: history.entity, ref_id: history.refId, action: history.action, by_id: history.byId,
      at: `${addD(SEED_TODAY, history.dayOffset)}T${String(9 + (n % 8)).padStart(2, '0')}:00:00+09:00`,
    })));
    // 리포트 발송 이력 표본(W11 R2 · 7-3 ③ · F3 e2e) — 그날 리포트가 전부 승인된 학생 하루 둘 · 가짜 발송자 · 시험 데이터만
    done.push(...await seedReportSends(q, SEED_TODAY));

    // ── 회계
    /* F12 「이월 막힘」 표본(money.CARRY_BLOCKED) — 다음 달 수업료 초안. 월말 일괄 발행(`issueOne`)이 만드는 모양이고,
       줄 · 금액은 **제품의 줄 계산**(`invoiceLines`)이 위 투영이 편 다음 달 회차로 센 그대로다(시드가 금액을 적지 않는다).
       셀 수 없으면(회차 없음 · 단가 없음 — 발행도 막히는 자리) 던진다. 받는 달에 넘어온 이월(carry)은 시드에 없다. */
    const nextLines = await invoiceLines(q, CARRY_BLOCKED.studentId, CARRY_BLOCKED.nextMonth);
    if (!nextLines.length || nextLines.some((l) => l.unit_price === null)) {
      throw new Error(`시드: ${CARRY_BLOCKED.nextMonth} 학생 ${CARRY_BLOCKED.studentId} 의 수업료 줄을 셀 수 없습니다(회차 없음 · 단가 없음)`);
    }
    const blockedNext = {
      id: CARRY_BLOCKED.nextInvId, studentId: CARRY_BLOCKED.studentId, yearMonth: CARRY_BLOCKED.nextMonth, invType: 'tuition',
      title: invoiceTitle(CARRY_BLOCKED.nextMonth, 'tuition'), amount: linesTotal(nextLines), state: 'draft',
      issuedOn: CARRY_BLOCKED.issuedOn, dueOn: CARRY_BLOCKED.dueOn, paidAmount: 0,
    };
    await add('inv', [...INVOICES, blockedNext].map((i) => ({ id: i.id, student_id: i.studentId, year_month: i.yearMonth, inv_type: i.invType, title: i.title, amount: i.amount, state: i.state, issued_on: i.issuedOn, due_on: i.dueOn, paid_amount: i.paidAmount, paid_at: (i as { paidAt?: string }).paidAt ? `${(i as { paidAt?: string }).paidAt}T00:00:00Z` : null, created_by: 2 })));
    await add('inv_line', [
      ...INV_LINES.map((l) => ({ inv_id: l.invId, sub_key: l.subKey, label: l.label, count: l.count, unit_price: l.unitPrice, amount: l.count * l.unitPrice, seq: l.seq })),
      // 발행(`issueOne`)이 적는 모양 그대로 — 줄 차례는 0 부터
      ...nextLines.map((l, seq) => ({ inv_id: CARRY_BLOCKED.nextInvId, sub_key: l.sub_key, label: l.label, count: l.n, unit_price: Number(l.unit_price), amount: l.n * Number(l.unit_price), seq })),
    ]);
    await add('pay', PAYMENTS.map((p) => ({ inv_id: p.invId, student_id: p.studentId, amount: p.amount, paid_on: p.paidOn, method: p.method, reason: (p as { reason?: string }).reason ?? null, entered_by: p.enteredBy, entered_at: `${p.paidOn}T00:00:00Z`, confirmed_by: p.confirmedBy, confirmed_at: `${p.paidOn}T01:00:00Z` })));
    await add('expense', EXPENSES.map((e) => ({ spend_on: e.spendOn, category: e.category, merchant: e.merchant, purpose: e.purpose, requested_amount: num((e as { requestedAmount?: number }).requestedAmount), amount: e.amount, receipt_url: e.receiptUrl, requester_id: e.requesterId, state: e.state, reviewer_id: e.reviewerId })));
    await add('payout', PAYOUTS.map((p) => ({ staff_id: p.staffId, year_month: p.yearMonth, hours: p.hours, gross: p.gross, late_rep_cut: p.lateRepCut, late_cls_cut: 0, income_tax: p.incomeTax, local_tax: p.localTax, net: p.net, state: p.state, confirmed_by: p.confirmedBy, confirmed_at: p.confirmedBy === null ? null : `${p.yearMonth}-28T09:00:00Z` })));

    // ── 운영
    await add('req', REQS.map((r) => ({ staff_id: r.staffId, req_type: r.reqType, payload: JSON.stringify(r.payload), state: r.state, resolved_by: num((r as { resolvedBy?: number }).resolvedBy), reject_reason: (r as { rejectReason?: string }).rejectReason ?? null, created_at: `${r.createdAt}T00:00:00Z` })));
    await add('chreq', CHREQS.map((c) => ({ ser_id: c.serId, on_date: c.onDate, req_type: c.reqType, payload: JSON.stringify(c.payload), reason: c.reason, reject_reason: (c as { rejectReason?: string }).rejectReason ?? null, state: c.state, by_id: c.byId, resolved_by: num((c as { resolvedBy?: number }).resolvedBy), apply_all: c.applyAll, created_at: `${c.createdAt}T00:00:00Z` })));
    await add('gpapack', GPAPACKS.map((g, n) => ({
      id: n + 1, pack_type: g.packType,
      title: g.packType === 'exam' ? '시험 대비 자료 요청' : '자습 자료 요청',
      memo: g.detail, state: g.state === 'approved' ? 'delivered' : 'pending',
      effective_on: g.createdAt, coordinator_id: 4, created_by: 3,
      delivered_by: g.state === 'approved' ? 3 : null,
      delivered_at: g.state === 'approved' ? `${g.createdAt}T10:00:00Z` : null,
      created_at: `${g.createdAt}T09:00:00Z`, updated_at: `${g.createdAt}T10:00:00Z`,
    })));
    await add('gpapack_student', GPAPACKS.flatMap((g, n) => [
      { gpapack_id: n + 1, student_id: g.studentId },
      ...(n === 1 ? [{ gpapack_id: n + 1, student_id: 5 }] : []),
    ]));
    await add('gpapack_lib', [
      { gpapack_id: 1, lib_id: 2, vers_id: 3 },
      { gpapack_id: 2, lib_id: 1, vers_id: 1 },
      { gpapack_id: 2, lib_id: 4, vers_id: 5 },
    ]);
    await add('noti', NOTIS.map((n) => ({ to_id: n.toId, from_id: n.fromId, body: n.body, link: n.link, category: n.category, read_at: (n as { readAt?: string }).readAt ? `${(n as { readAt?: string }).readAt}T00:00:00Z` : null, created_at: `${n.createdAt}T00:00:00Z` })));
    await add('cons', CONSULTINGS.map((c) => ({ id: c.id, cons_type: c.consType, stage: c.stage, contract_step: c.contractStep, amount: c.amount, sessions: c.sessions, start_on: (c as { startOn?: string }).startOn ?? null, end_on: c.endOn, owner_id: c.ownerId, share: c.share, requester: c.requester })));
    await add('cons_stu', CONSULTINGS.flatMap((c) => c.students.map((s) => ({ cons_id: c.id, student_id: s }))));
    await add('cons_pick', CONS_PICKS.map((p) => ({ cons_id: p.consId, staff_id: p.staffId })));
    await add('cons_item', CONS_ITEMS.map((x) => ({ cons_id: x.consId, seq: x.seq, label: x.label, done: x.done, done_by: x.doneBy, done_at: x.doneAt })));
    await add('cons_pay', CONS_PAYS.map((p) => ({ cons_id: p.consId, amount: p.amount, paid_on: p.paidOn, memo: p.memo, by_id: 2 })));
    await add('diag', DIAGS.map((d) => ({ student_id: d.studentId, ser_id: d.serId, level_summary: d.levelSummary, strengths: d.strengths, weaknesses: d.weaknesses, curriculum: d.curriculum, created_by: d.createdBy })));
    // 상담 진단 점수(DQ1) — 강사 진단 리포트(diag)와 다른 표다. 레벨·교재는 담당자가 고른 표본 값이다
    await add('lead_diag', LEAD_DIAGS.map((d) => ({ lead_id: d.leadId, english: d.english, math: d.math, interview: d.interview, taken_on: rel(d.takenOn), level: d.level, book_id: d.bookId, note: d.note, created_by: d.createdBy, created_at: `${rel(d.takenOn)}T09:00:00Z` })));
    // 배치안 초안 · 2차/진단 일정 (23-15 · 23-16) — 일정은 **시간표에 만들기 전**(ser_id NULL · 「미생성」)으로만 둔다
    await add('lead_plan', LEAD_PLANS.map((p) => ({ lead_id: p.leadId, seq: p.seq, kind_key: p.kindKey, sub_key: p.subKey, per_week: p.perWeek, teacher_id: p.teacherId, created_by: p.createdBy, created_at: `${rel(p.on)}T02:00:00Z` })));
    await add('lead_appt', LEAD_APPTS.map((a) => ({ lead_id: a.leadId, kind: a.kind, on_date: rel(a.onDate), start_min: a.startMin, end_min: a.endMin, mode: a.mode, room_id: a.roomId, created_by: a.createdBy })));
    await add('gpasvc', GPASVCS);
    await add('gpa_cycle', GPA_CYCLES.map((c) => ({ id: c.id, no: c.no, from_date: c.fromDate, to_date: c.toDate, closed: c.closed })));
    await add('gpa_alloc', GPA_ALLOCS.map((a) => ({ cycle_id: a.cycleId, student_id: a.studentId, coord_id: a.coordId, points: a.points })));
    await add('gpa_use', GPA_USES.map((u) => ({ cycle_id: u.cycleId, student_id: u.studentId, ser_id: u.serId, svc_key: u.svcKey, points: u.points, on_date: u.onDate, start_min: u.startMin, coord_id: u.coordId, state: u.state })));
    await add('cons_sess', CONS_SESSIONS.map((s) => ({ cons_id: s.consId, seq: s.seq, on_date: s.onDate, who: s.who, what: s.what, why: s.why, how: s.how })));
    await add('mkt', MKTS.map((m) => ({ id: m.id, channel: m.channel, item: m.item, url: m.url, result: JSON.stringify(m.result), on_date: m.onDate, title: m.title ?? null, by_id: m.byId ?? null, memo: m.memo ?? null })));
    await add('mfb', MFBS.map((f) => ({ id: f.id, mkt_id: f.mktId, by_id: f.byId, kind: f.kind, parent_id: f.parentId, body: f.body, at: f.at })));
    // 기한 승인은 **시각과 사람이 짝**이다(plan_due_approval_pair) — 한쪽만 적은 줄은 DB 가 막는다
    await add('plan', PLANS.map((p) => {
      const due = p as { dueApprovedAt?: string; dueApprovedBy?: number };
      return {
        id: p.id, title: p.title, stage: p.stage, goal: p.goal, research: p.research, ask: p.ask, due_on: p.dueOn, owner_id: p.ownerId,
        due_approved_at: due.dueApprovedAt ? `${due.dueApprovedAt}T00:00:00Z` : null, due_approved_by: due.dueApprovedBy ?? null,
      };
    }));
    await add('mtrec', MEETINGS.map((m) => ({ id: m.id, mt_type: m.mtType, title: m.title, on_date: m.onDate, minutes: m.minutes, ser_id: m.serId })));
    /* 참석은 **세 값**이다 — null(아직 답 안 함) · true(참석) · false(불참).
       한동안 시드가 `minutes !== null` 로 true/false 만 만들어서 **「응답 대기」가 데모에
       한 번도 안 나왔다.** 원문 §66 컷은 네 명이 전부 「응답 대기」다 (C57).
       지난 회의(속기록이 있는 것)는 답이 다 왔고, 앞으로 올 회의는 아직 답을 기다린다 —
       한 명만 불참으로 두어 세 칩이 화면에 다 나오게 한다. */
    await add('mtattd', MEETINGS.flatMap((m) => m.attendees.map((a, i) => ({
      mt_id: m.id, staff_id: a,
      confirmed: m.minutes !== null ? true : i === 0 ? false : null,
    }))));
    await add('cpl', COMPLAINTS.map((c) => ({ area: c.area, student_id: c.studentId, stage: c.stage, body: c.body, action: (c as { action?: string }).action ?? null, result: (c as { result?: string }).result ?? null, teacher_changed: c.teacherChanged, owner_id: c.ownerId, created_at: `${c.createdAt}T00:00:00Z`, severity: c.severity, requester: c.requester ?? null, closed_at: c.closedAt ? `${c.closedAt}T09:00:00Z` : null })));
    await add('suggestion', SUGGESTIONS.map((s) => ({ staff_id: s.staffId, category: s.category, body: s.body, state: s.state, reply: (s as { reply?: string }).reply ?? null, reply_by: num((s as { replyBy?: number }).replyBy), reply_at: (s as { replyAt?: string }).replyAt ? `${(s as { replyAt?: string }).replyAt}T00:00:00Z` : null, created_at: `${s.createdAt}T00:00:00Z` })));
    // 서명은 **시각과 사람이 짝**이다 — 한쪽만 넣으면 rpt_sign_pair 가 막는다 (C85-a)
    await add('rpt', REPORTS.map((r) => {
      const at = r as { sentAt?: string; sentBy?: number; reviewedAt?: string; reviewedBy?: number };
      return {
        rpt_type: r.rptType, on_date: r.onDate, memo: JSON.stringify(r.memo), state: r.state,
        sent_at: at.sentAt ? `${at.sentAt}T00:00:00Z` : null,
        sent_by: at.sentBy ?? null,
        reviewed_at: at.reviewedAt ? `${at.reviewedAt}T00:00:00Z` : null,
        reviewed_by: at.reviewedBy ?? null,
      };
    }));
    await add('todo', TODOS.map((t) => ({ title: t.title, from_id: t.fromId, to_id: t.toId, due_on: t.dueOn, done: t.done, src: t.src, mt_id: num((t as { mtId?: number }).mtId), plan_id: num((t as { planId?: number }).planId),
      lead_id: num((t as { leadId?: number }).leadId), care: (t as { care?: string }).care ?? null })));
    // 보호자 (DQ3) — 만든 사람은 관리자(2). 발송 원장은 비워 둔다
    await add('guardian', GUARDIANS.map((g) => ({ student_id: g.studentId, name: g.name, relation: g.relation, email: g.email, phone: g.phone, receive_email: g.receiveEmail, receive_sms: g.receiveSms, is_primary: g.isPrimary, created_by: 2 })));
    // 기존 scalar를 사용하는 시드도 선택 연락처를 갖는다. 이 가짜 fixture의 연락처는 scalar 복사본이며 실제 작성자를 추정하지 않는다.
    const seededGuardians = await q.query(
      `SELECT id, student_id, name, email, phone FROM guardian WHERE created_by = 2 AND student_id = ANY($1::bigint[])`,
      [[...new Set(GUARDIANS.map((g) => g.studentId))]],
    ) as Array<{ id: string; student_id: string; name: string; email: string | null; phone: string | null }>;
    const guardianContacts: Record<string, unknown>[] = [];
    for (const fixture of GUARDIANS) {
      const matches = seededGuardians.filter((g) => Number(g.student_id) === fixture.studentId && g.name === fixture.name
        && g.email === fixture.email && g.phone === fixture.phone);
      if (matches.length !== 1) throw new Error(`seed guardian contact owner is not unique: ${fixture.studentId} / ${fixture.name}`);
      const owner = Number(matches[0].id);
      if (fixture.email !== null) guardianContacts.push({ guardian_id: owner, kind: 'email', value: fixture.email, is_delivery_selected: true, origin: 'legacy_copy', created_by: null });
      if (fixture.phone !== null) guardianContacts.push({ guardian_id: owner, kind: 'phone', value: fixture.phone, is_delivery_selected: true, origin: 'legacy_copy', created_by: null });
    }
    await add('guardian_contact', guardianContacts);

    // 손으로 넣은 id 뒤로 시퀀스를 밀어 둔다 — 안 하면 다음 INSERT 가 충돌한다
    for (const t of ['room', 'zacc', 'staff', 'stu', 'lead', 'ser', 'lib', 'file', 'vers', 'gpapack', 'inv', 'cons', 'plan', 'mtrec', 'gpa_cycle', 'mkt', 'mfb']) {
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
