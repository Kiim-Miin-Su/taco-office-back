/** @file-guide
 * 목적: enroll.service.ts — LeadEnrollService (service)
 * 책임/재사용: 등록 확정을 한 트랜잭션으로 묶는다 — 시간표·청구서·교재·안내의 **기존 쓰기 함수**를 순서대로 부르고 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 등록 확정 — 테스트 시나리오 A-05 「배치안을 만들고 등록을 확정함 — 한 번에 일곱 가지」 (C91).
 *
 * v2 §23(상담 카드) · §25(배치안) · §79 · §12 · §53 · §38 · §43 · §16 이 각각 말하는 일곱을 **한 트랜잭션**에서 한다 —
 *   ① STU(없으면 만든다 · 동명이인은 학년·학교로 가른다 N-137) ② ENR(줄마다 · 시작일) ③ SER+SER_STU(줄마다 `ScheduleWriteService.create`
 *   — EXCLUDE 가 겹침을 막고(A-06) UNAV 는 응답으로 알린다(A-07)) ④ 첫 달 수업료 청구서(`issueWithin` · §53 그대로 · 단가 없으면 건너뛰고 이유)
 *   ⑤ 교재 요청(줄에 libId 가 있으면 ISSUE wait · 없으면 「교재 배정이 필요합니다」 알림) ⑥ 첫 수업 안내 초안(`draftsForStudent`)
 *   ⑦ 알림(강사 · 관리자) 과 LEAD 단계 `enrolled` + `lead_stage_log` + LOG.
 * 하나라도 실패하면 전부 되돌린다 — 「학생은 생겼는데 시간표가 없다」가 생기지 않는다(D-R43).
 * 미리보기는 같은 트랜잭션을 끝까지 돌리고 되돌린다(D-R37 · C94-c 와 같은 모양) — 화면이 겹침·불가 시간·청구액을 짓지 않는다.
 *
 * 등록 실패 건도 **되살리기 없이 바로** 등록한다 — 원본 §24 「바로 수업 등록」 · 슬라이드 24 연동 「되살리기 없이 등록 확정
 * 화면으로. 실패 이력은 남습니다」(24-07). 이력은 도달 기록(`failed` 줄 뒤에 `enrolled` 줄)과 LOG 의 before(중단 지점 · 실패 전 단계)에
 * 남고, 상담 행의 중단 지점·실패 전 단계는 되살리기와 같이 비운다 — 등록 칸의 카드가 「중단」 칩을 달고 서지 않게.
 */
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { ruleLabel } from '../../lib/recurrence';
import { NOTI_TITLE } from '../../lib/noti';
import { AccountingService } from '../accounting/accounting.service';
import type { InvoiceDto } from '../accounting/accounting.dto';
import { BooksService } from '../books/books.service';
import type { BookIssueDto } from '../books/books.dto';
import { GuidesService } from '../guides/guides.service';
import { createGuardianWithin } from '../guardians/guardians.service';
import { maskPhone } from '../notify/sender';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import type { UnavWarnDto } from '../schedule/schedule.dto';
import type { EnrollGuardianCarryDto, EnrollMissingBookDto, EnrollResultDto, EnrollSeriesDto, LeadEnrollDto } from './enroll.dto';
import { latestLeadDiagBookId, latestLeadDiagForStudent } from './lead-diag.service';
import { planLeadCare } from './lead-care';

/** 미리보기의 되돌림 — 결과를 싣고 던져 트랜잭션을 통째로 되돌린다 (C94-c 의 `PreviewRollback` 과 같은 모양) */
class PreviewRollback extends Error {
  constructor(public readonly result: EnrollResultDto) { super('preview'); }
}

const md = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;

@Injectable()
export class LeadEnrollService {
  constructor(
    private readonly ds: DataSource,
    private readonly schedule: ScheduleWriteService,
    private readonly accounting: AccountingService,
    private readonly books: BooksService,
    private readonly guides: GuidesService,
  ) {}

  preview(userId: number, leadId: number, dto: LeadEnrollDto, canSeeAmounts: boolean): Promise<EnrollResultDto> {
    return this.run(userId, leadId, dto, canSeeAmounts, true);
  }

  enroll(userId: number, leadId: number, dto: LeadEnrollDto, canSeeAmounts: boolean): Promise<EnrollResultDto> {
    return this.run(userId, leadId, dto, canSeeAmounts, false);
  }

  private async run(userId: number, leadId: number, dto: LeadEnrollDto, canSeeAmounts: boolean, preview: boolean): Promise<EnrollResultDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const result = await this.body(q, userId, leadId, dto, canSeeAmounts, preview);
      if (preview) throw new PreviewRollback(result);
      await q.commitTransaction();
      return result;
    } catch (e) {
      await q.rollbackTransaction();
      if (e instanceof PreviewRollback) return e.result;
      throw e;
    } finally {
      await q.release();
    }
  }

  private async body(q: QueryRunner, userId: number, leadId: number, dto: LeadEnrollDto, canSeeAmounts: boolean, preview: boolean): Promise<EnrollResultDto> {
    const m: EntityManager = q.manager;

    /* ── 상담 건 잠금 — 등록된 건은 다시 못 한다. 보류 → 등록(A-12)도 실패 → 등록(24-07 「바로 수업 등록」)도 같은 길이다 ── */
    const [lead] = (await m.query(
      `SELECT id, name, school, stage, student_id, stop_at, fail_from, parent_relation, parent_phone FROM lead WHERE id = $1 FOR UPDATE`, [leadId],
    )) as Array<{
      id: string; name: string; school: string | null; stage: string; student_id: string | null; stop_at: string | null; fail_from: string | null;
      parent_relation: string | null; parent_phone: string | null;
    }>;
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    if (lead.stage === 'enrolled') throw new ConflictException({ code: 'ALREADY_ENROLLED', message: '이미 등록된 건입니다 — 수업을 더하려면 시간표에서 합니다' });

    /* ── ① STU — 있는 학생에게 붙이거나 새로 만든다. 동명이인은 학년·학교로 가른다 (N-137) ── */
    let studentId: number;
    let studentName: string;
    let studentCreated = false;
    if (dto.studentId) {
      const [stu] = (await m.query(`SELECT id, name FROM stu WHERE id = $1 FOR KEY SHARE`, [dto.studentId])) as Array<{ id: string; name: string }>;
      if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '그 학생을 찾을 수 없습니다' });
      studentId = Number(stu.id); studentName = stu.name;
    } else {
      const name = dto.student?.name?.trim() || lead.name;
      const grade = dto.student?.grade?.trim() || null;
      const school = (dto.student?.school !== undefined ? dto.student.school.trim() : lead.school) || null;
      const same = (await m.query(`SELECT id, grade, school FROM stu WHERE name = $1 ORDER BY id`, [name])) as Array<{ id: string; grade: string | null; school: string | null }>;
      if (same.length) {
        const twin = same.find((s) => (s.grade ?? '') === (grade ?? '') && (s.school ?? '') === (school ?? ''));
        if (twin) {
          throw new ConflictException({
            code: 'STUDENT_DUPLICATE',
            // 오류 몸통은 code·message 둘뿐이다(ApiErrorDto) — 누구인지는 문장에 싣는다
            message: `같은 이름·학년·학교의 학생(#${twin.id})이 이미 있습니다 — 같은 학생이면 기존 학생에 붙이고, 다른 사람이면 학년·학교를 달리 적습니다`,
          });
        }
        if (!dto.allowSameName) {
          throw new ConflictException({
            code: 'STUDENT_SAME_NAME',
            message: `이름이 같은 학생이 ${same.length}명 있습니다(${same.map((s) => `#${s.id} ${s.grade ?? '학년 없음'} · ${s.school ?? '학교 없음'}`).join(', ')}) — 다른 사람이 맞으면 「동명이인입니다」를 체크하고 다시 보냅니다`,
          });
        }
      }
      const [made] = (await m.query(
        `INSERT INTO stu (name, grade, school, target_exam, started_on, guidance, lang, gender) VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8) RETURNING id`,
        // 성별은 선택 칸이다(N-83) — 안 보냈으면 NULL, 추정하지 않는다
        [name, grade, school, dto.student?.targetExam?.trim() || null, dto.startedOn, dto.student?.guidance?.trim() || null, dto.student?.lang?.trim() || null,
         dto.student?.gender ?? null],
      )) as Array<{ id: string }>;
      studentId = Number(made.id); studentName = name; studentCreated = true;
    }

    /* ── ② ENR — 줄마다 ── */
    const enrollments: EnrollResultDto['enrollments'] = [];
    for (const line of dto.lines) {
      const [enr] = (await m.query(
        `INSERT INTO enr (student_id, kind_key, sub_key, sessions, started_on) VALUES ($1,$2,$3,$4,$5::date) RETURNING id`,
        [studentId, line.kindKey, line.subKey ?? null, line.sessions ?? null, dto.startedOn],
      )) as Array<{ id: string }>;
      enrollments.push({ id: Number(enr.id), kindKey: line.kindKey, subKey: line.subKey ?? null, sessions: line.sessions ?? null, startedOn: dto.startedOn });
    }

    /* ── ③ SER + SER_STU — 줄마다 시간표 쓰기 그대로. 겹치면 시간표가 409 로 막고 전부 되돌아간다 (A-06) ── */
    const serIds: number[] = [];
    const unavailable: UnavWarnDto[] = [];
    for (const line of dto.lines) {
      const written = await this.schedule.create({
        kindKey: line.kindKey, subKey: line.subKey ?? null, mode: line.mode, fromDate: dto.startedOn, toDate: null,
        rrule: line.rrule, startMin: line.startMin, endMin: line.endMin,
        teacherId: line.teacherId ?? null, roomId: line.roomId ?? null, title: line.title ?? null, studentIds: [studentId],
      }, userId, q);
      serIds.push(...written.serIds);
      unavailable.push(...written.unavailable);
    }
    // 첫 수업일 — 투영된 회차에서 (A-14 「등록 직후 첫 수업일 확인」)
    const firsts = (await m.query(
      `SELECT ser_id, to_char(min(on_date),'YYYY-MM-DD') AS first_on FROM ser_occ WHERE ser_id = ANY($1) AND NOT canceled GROUP BY ser_id`, [serIds],
    )) as Array<{ ser_id: string; first_on: string }>;
    const firstOf = new Map(firsts.map((r) => [Number(r.ser_id), r.first_on]));
    const firstLessonOn = firsts.map((r) => r.first_on).sort()[0] ?? null;
    const invoiceMonth = (firstLessonOn ?? dto.startedOn).slice(0, 7);
    const serRows = (await m.query(
      `SELECT s.id, s.kind_key, s.sub_key, sb.name AS sub_name, s.title, s.rrule, s.start_min, s.end_min, s.teacher_id, st.name AS teacher_name,
              (SELECT count(*) FROM ser_occ o WHERE o.ser_id = s.id AND NOT o.canceled AND to_char(o.on_date,'YYYY-MM') = $2)::int AS month_count
         FROM ser s LEFT JOIN sub sb ON sb.key = s.sub_key LEFT JOIN staff st ON st.id = s.teacher_id
        WHERE s.id = ANY($1) ORDER BY s.id`, [serIds, invoiceMonth],
    )) as Array<Record<string, unknown>>;
    const series: EnrollSeriesDto[] = serRows.map((r) => ({
      serId: Number(r.id), kindKey: String(r.kind_key), subKey: (r.sub_key as string | null) ?? null, subName: (r.sub_name as string | null) ?? null,
      title: String(r.title ?? ''), ruleLabel: ruleLabel({ rrule: String(r.rrule) }), startMin: Number(r.start_min), endMin: Number(r.end_min),
      teacherId: r.teacher_id == null ? null : Number(r.teacher_id), teacherName: (r.teacher_name as string | null) ?? null,
      firstLessonOn: firstOf.get(Number(r.id)) ?? null, monthCount: Number(r.month_count),
    }));

    /* ── ④ 첫 달 청구서 — §53 발행 그대로. 단가 없음·회차 없음은 등록을 막지 않고 이유로 돌아온다 (SAVEPOINT) ── */
    let invoice: InvoiceDto | null = null;
    let invoiceSkipped: EnrollResultDto['invoiceSkipped'] = null;
    if (dto.issueInvoice !== false) {
      // DTO 가 `issueInvoice !== false` 일 때 기한을 필수로 받는다 — 여기 오면 값이 있다
      const dueOn = dto.dueOn;
      if (!dueOn) throw new BadRequestException({ code: 'INV_DUE_REQUIRED', message: '청구서를 함께 내려면 납부 기한을 골라 주세요' });
      await m.query('SAVEPOINT enroll_invoice');
      try {
        invoice = await this.accounting.issueWithin(m, userId, { studentId, yearMonth: invoiceMonth, invType: 'tuition', dueOn }, canSeeAmounts);
        await m.query('RELEASE SAVEPOINT enroll_invoice');
      } catch (e) {
        await m.query('ROLLBACK TO SAVEPOINT enroll_invoice');
        if (!(e instanceof HttpException)) throw e;
        const res = e.getResponse() as { code?: string; message?: string } | string;
        invoiceSkipped = typeof res === 'string' ? { code: 'INV_SKIPPED', message: res } : { code: res.code ?? 'INV_SKIPPED', message: res.message ?? e.message };
      }
    }

    /* ── ⑤ 교재 — 줄에 교재가 있으면 요청(wait), 없으면 배정이 필요하다고 알린다 (§38) ──
       줄이 교재 키를 **보내지 않았으면** 상담 진단에서 담당자가 고른 교재(최신 줄 · DQ1)를 그런 줄 가운데 첫 줄에 한 번 쓴다.
       서버가 교재를 고르는 것이 아니다 — 사람이 이미 고른 값을 다시 적게 하지 않을 뿐이고, null(「교재 미정」)은 덮지 않는다. */
    let pickedBook = await latestLeadDiagBookId(m, leadId);
    let diagBookApplied = false;
    const bookIssues: BookIssueDto[] = [];
    const booksMissing: EnrollMissingBookDto[] = [];
    const codes = (await m.query(
      `SELECT k.key AS kind_key, k.name AS kind_name, NULL::text AS sub_key, NULL::text AS sub_name FROM kind k WHERE k.key = ANY($1)
       UNION ALL SELECT NULL, NULL, sb.key, sb.name FROM sub sb WHERE sb.key = ANY($2)`,
      [dto.lines.map((l) => l.kindKey), dto.lines.map((l) => l.subKey).filter((k): k is string => !!k)],
    )) as Array<{ kind_key: string | null; kind_name: string | null; sub_key: string | null; sub_name: string | null }>;
    const kindName = (key: string) => codes.find((c) => c.kind_key === key)?.kind_name ?? key;
    const subName = (key: string | null | undefined) => (key ? codes.find((c) => c.sub_key === key)?.sub_name ?? key : null);
    for (const line of dto.lines) {
      let libId = line.libId ?? null;
      if (line.libId === undefined && pickedBook !== null) {
        libId = pickedBook; pickedBook = null; diagBookApplied = true;
      }
      if (libId) {
        bookIssues.push(await this.books.createIssueWithin(m, userId, { libId, studentId, state: 'wait' }));
      } else {
        booksMissing.push({ kindKey: line.kindKey, subKey: line.subKey ?? null, label: subName(line.subKey) ?? kindName(line.kindKey) });
      }
    }

    /* ── ⑥ 첫 수업 안내 초안 — §45 누락 판정과 같은 함수 ── */
    const guideIds = await this.guides.draftsForStudent(m, userId, studentId);

    /* ── ⑦ 알림 — 강사(줄마다 · 본인 제외) · 관리자 전원(본인 제외) · 교재 배정 필요 ── */
    const teacherIds = [...new Set(series.map((s) => s.teacherId).filter((id): id is number => id != null && id !== userId))];
    let notifiedTeachers = 0;
    for (const teacherId of teacherIds) {
      const mine = series.filter((s) => s.teacherId === teacherId);
      const first = mine.map((s) => s.firstLessonOn).filter((d): d is string => !!d).sort()[0];
      const rows = (await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title) SELECT $1, $2, $3, $4, 'schedule', $5 FROM staff WHERE id = $1 AND active RETURNING id`,
        [teacherId, userId,
          `새 학생 등록 — ${studentName} · ${mine.map((s) => s.subName ?? s.title ?? kindName(s.kindKey)).join(' · ')}${first ? ` · 첫 수업 ${md(first)}` : ''}`,
          first ? `/schedule?date=${first}` : '/schedule', NOTI_TITLE.enrollNewStudent],
      )) as Array<{ id: string }>;
      notifiedTeachers += rows.length;
    }
    const staffRows = (await m.query(
      `INSERT INTO noti (to_id, from_id, body, link, category, title)
       SELECT id, $1, $2, '/ops', 'etc', $3 FROM staff WHERE active AND role <> 'teacher' AND id <> $1 RETURNING id`,
      [userId, `등록 확정 — ${studentName} · 수업 ${series.length}개${firstLessonOn ? ` · 첫 수업 ${md(firstLessonOn)}` : ''}${invoice ? ` · ${invoiceMonth} 청구서 발행` : invoiceSkipped ? ` · 청구서 없음: ${invoiceSkipped.message}` : ''}`, NOTI_TITLE.enrollConfirmed],
    )) as Array<{ id: string }>;
    let notifiedStaff = staffRows.length;
    if (booksMissing.length) {
      const rows = (await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT id, $1, $2, '/books', 'request', $3 FROM staff WHERE active AND role <> 'teacher' AND id <> $1 RETURNING id`,
        [userId, `교재 배정이 필요합니다 — ${studentName} · ${booksMissing.map((b) => b.label).join(' · ')}`, NOTI_TITLE.bookNeeded],
      )) as Array<{ id: string }>;
      notifiedStaff += rows.length;
    }

    /* ── ⑧ 보호자 — 문의 때 적은 학부모 · 연락처(A-01)를 그 학생의 보호자로 잇는다 (DQ3 · 「+ 보호자 추가」와 같은 함수) ──
       같은 번호의 보호자가 이미 있으면(사용 중지한 줄 포함 — 사람이 끈 것을 되살리지 않는다) 잇지 않는다.
       받는 채널은 켜지 않는다 — 「+ 보호자 추가」의 기본(문자 받기 꺼짐)과 같다. 문자를 받을지는 보호자 화면에서 사람이 켠다. */
    let guardianCarried: EnrollGuardianCarryDto | null = null;
    if (lead.parent_phone) {
      const same = (await m.query(`SELECT 1 FROM guardian WHERE student_id = $1 AND phone = $2`, [studentId, lead.parent_phone])) as unknown[];
      if (!same.length) {
        const g = await createGuardianWithin(q, studentId, {
          name: `${studentName} ${lead.parent_relation ?? '보호자'}`.slice(0, 40), relation: lead.parent_relation ?? undefined, phone: lead.parent_phone,
        }, userId);
        guardianCarried = { name: g.name, relation: g.relation ?? null, phoneDisplay: g.phoneDisplay ?? lead.parent_phone };
      }
    }

    /* ── LEAD 단계 → enrolled · 도달 기록 · LOG ── */
    // 실패 건에서 바로 온 경우 실패 전 단계(fail_from — 지금 실패 중인 건의 판정 값)를 비운다(되살리기와 같다) — 이력은 도달 기록과 아래 LOG before 에 남는다 (24-07)
    // 옛 중단 지점(stop_at)은 읽기 전용 기록이라 건드리지 않는다(W11 · N-87)
    await m.query(
      `UPDATE lead SET stage = 'enrolled', student_id = $2, reason = COALESCE($3, reason), fail_from = NULL WHERE id = $1`,
      [leadId, studentId, dto.memo?.trim() || null],
    );
    await m.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'enrolled', $2)`, [leadId, userId]);
    await m.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'enroll',$3::jsonb,$4::jsonb)`,
      [userId, leadId, JSON.stringify(lead.stage === 'failed'
        ? { stage: lead.stage, stopAt: lead.stop_at, failFrom: lead.fail_from }
        : { stage: lead.stage }), JSON.stringify({
        stage: 'enrolled', studentId, studentCreated, startedOn: dto.startedOn, serIds, enrIds: enrollments.map((e) => e.id),
        invId: invoice?.id ?? null, invoiceSkipped: invoiceSkipped?.code ?? null, issueIds: bookIssues.map((b) => b.id), guideIds, preview,
        diagBookApplied,
        // 번호는 가린 모양만 (N-42 · 보호자 LOG 와 같다)
        guardianCarried: guardianCarried && lead.parent_phone
          ? { name: guardianCarried.name, relation: guardianCarried.relation, phone: maskPhone(lead.parent_phone) } : null,
      })],
    );
    // 상담 진단은 방금 채운 lead.student_id 를 따라 그 학생의 것이 된다 — 같은 트랜잭션에서 그 연결로 다시 읽어 보여 준다(DQ1)
    const latestDiag = await latestLeadDiagForStudent(m, studentId);

    /* ── W11 · N-86 사후 관리 — 해피콜(첫 실제 수업 + 7일) · 첫 월간 상담을 상담 담당의 할 일로. 같은 트랜잭션이다(미리보기는 함께 되돌린다) ── */
    const care = await planLeadCare(m, { leadId, studentId, studentName, serIds, startedOn: dto.startedOn, byId: userId });

    return {
      leadId, preview, studentId, studentName, studentCreated, startedOn: dto.startedOn,
      enrollments, series, invoice, invoiceSkipped, bookIssues, booksMissing,
      guideDrafts: guideIds.length, notifiedTeachers, notifiedStaff, unavailable, stage: 'enrolled',
      diagBookApplied, latestDiag, guardianCarried,
      aftercare: {
        firstLessonOn: care.firstLessonOn, happyCallOn: care.happyCallOn, monthlyOn: care.monthlyOn,
        ownerId: care.ownerId, ownerName: care.ownerName,
      },
    };
  }
}
