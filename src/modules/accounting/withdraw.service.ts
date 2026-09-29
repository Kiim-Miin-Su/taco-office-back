/** @file-guide
 * 목적: withdraw.service.ts — StudentWithdrawService (service)
 * 책임/재사용: 수강 종료·환불을 한 트랜잭션에서 — 명단 기간(SER_STU.to_date) · ENR 종료 · 청구서 음수 줄 · 환불 PAY 줄 · LOG. 잔여 회차 값은 invoice-lines 한 곳이 센다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 수강 종료 · 중도 환불 — C94-c (테스트 시나리오 H-80 「중도 환불」 · N-135 「학부모가 환불을 강하게 요구」 · N-136 「학생이 갑자기 그만둠」).
 *
 * 「잔여 회차 × 회당 단가로 산출 · 환불 기록이 장부에 남는다 · 수강이 종료 처리된다 · 이후 일정이 정리된다 ·
 *  그룹 수업이면 남은 학생 단가가 다시 계산된다 · 이력에 전 과정이 남는다」.
 *
 * 순서가 곧 설계다 —
 *   ① 종료일 뒤에 남은 회차의 값을 **먼저** 센다 — `invoiceLines(slice: after)` · 청구서와 같은 단가·같은 갈래(휴강·그날만 빠짐·휴원 제외)
 *   ② 명단에 종료일을 적는다(`ser_stu.to_date`) — 행을 지우지 않는다(N-50 ①). 그 뒤 회차는 시간표·§54·청구서·단가 구간에서 빠진다
 *   ③ 그 회차가 들어 있던 청구서에서 그만큼을 **음수 줄로** 뺀다(C92-b 이월과 같은 모양) · 받은 돈이 새 금액보다 많으면 **PAY 음수 줄**로 돌려준다
 *      · 금액이 0 이 되면 void 로 접는다 · 상태는 받은 돈 ÷ 금액으로 다시 선다
 *   ④ 수강(ENR)에 종료일 · LOG `STU withdraw` — 누가·언제·무엇을·얼마를 · 컴플레인에서 열었으면 LOG `CPL refund`(J-99 · N-135)
 * 미리보기는 같은 트랜잭션을 끝까지 돌리고 되돌린다 — 화면이 「환불 예정 N원」을 따로 세지 않는다(D-R37).
 * 되돌리는 길은 없다 — 종료한 학생을 같은 규칙에 다시 넣을 수 없다(ROSTER_ENDED · 새 규칙으로 등록한다).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { todayKst } from '../../lib/kst';
import { assertMonthOpen } from '../../lib/month-close';
import { writtenRows } from '../../lib/sql';
import { CPL_OPEN_STAGES, CPL_REFUND_LOG, type CplStage } from '../../lib/complaint-words';
import { invoiceLines, linesTotal, mixedDiagIntakeLines, type InvoiceLineRow, type LineInvType } from './invoice-lines';
import type { StudentWithdrawDto, WithdrawInvoiceDto, WithdrawResultDto, WithdrawSeriesDto } from './accounting.dto';

/** 미리보기 — 트랜잭션을 끝까지 돌린 뒤 이 예외로 되돌린다. 실제와 같은 계산이라 「미리 본 값」과 「낸 값」이 갈리지 않는다 */
class PreviewRollback extends Error {
  constructor(readonly result: WithdrawResultDto) { super('preview'); }
}

interface SeriesRow { ser_id: string; kind_key: string; sub_key: string | null; title: string | null; to_date: string | null }
interface InvRow { id: string; year_month: string; inv_type: LineInvType; title: string; state: string; amount: number; paid_amount: number; sent_at: Date | null }

/** 옛 수업료 청구서에 진단고사 · 상담 줄이 섞여 멈출 때의 문장 — 미리보기와 쓰기가 같은 말을 쓴다 (W11 A' 후속) */
const withdrawMixedMessage = (yearMonth: string): string =>
  `${yearMonth} 수업료 청구서에 진단고사 · 상담 회차가 함께 청구돼 있습니다(따로 청구하기 전의 청구서) — `
  + '종료일 뒤 그 회차의 환불 몫은 사람이 확인해야 합니다. 청구서를 확인한 뒤 처리하거나, 진단고사 · 상담은 빼고 「이 수업만」 종료하세요';

@Injectable()
export class StudentWithdrawService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 미리보기 — 쓰기 0. 같은 트랜잭션을 돌리고 되돌린다 */
  async preview(userId: number, dto: StudentWithdrawDto, canSeeAmounts: boolean, canVoidInvoice: boolean): Promise<WithdrawResultDto> {
    try {
      await this.ds.transaction(async (m) => { await this.run(m, userId, dto, canSeeAmounts, canVoidInvoice, true); });
    } catch (e) {
      if (e instanceof PreviewRollback) return e.result;
      throw e;
    }
    /* istanbul ignore next — run() 은 미리보기에서 반드시 PreviewRollback 을 던진다 */
    throw new Error('withdraw preview did not roll back');
  }

  async withdraw(userId: number, dto: StudentWithdrawDto, canSeeAmounts: boolean, canVoidInvoice: boolean): Promise<WithdrawResultDto> {
    return this.ds.transaction((m) => this.run(m, userId, dto, canSeeAmounts, canVoidInvoice, false));
  }

  /**
   * `canVoidInvoice` — **청구서를 `void` 로 접는 것은 대표만 한다**(N-139 · `canCeoVoidInvoice`).
   *
   * 전용 경로 `POST /invoices/{id}/void` 는 `canMoney` **위에** 그 줄을 따로 걸어 두었는데
   * (「회계 탭에 금액 예외로 들어온 매니저가 장부를 지울 수 있으면 안 된다」) 이 경로는 `canMoney` 만으로
   * 같은 상태에 닿고 있었다 — **같은 일에 두 문이 있고 한쪽만 잠겨 있었다**(2026-09-20 전수 검수).
   *
   * 환불 자체는 막지 않는다. 막는 것은 **금액이 0 이 되어 청구서를 접는 경우** 하나뿐이고,
   * 미리보기가 그 사실을 먼저 말한다(`canConfirm`·`confirmBlockedReason` · D-R39).
   */
  private async run(
    m: EntityManager, userId: number, dto: StudentWithdrawDto,
    canSeeAmounts: boolean, canVoidInvoice: boolean, preview: boolean,
  ): Promise<WithdrawResultDto> {
    const today = todayKst();
    const reason = dto.reason?.trim() || null;
    const money = (v: number): number | null => (canSeeAmounts ? v : null);

    const [stu] = (await m.query(`SELECT id, name FROM stu WHERE id = $1 FOR UPDATE`, [dto.studentId])) as Array<{ id: string; name: string }>;
    if (!stu) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
    /*
     * 컴플레인에서 연 종료 (J-99 · N-135 「연결이 끊기면 실패」) — 어느 쓰기도 하기 전에 잠그고 판정한다.
     * 학생 A 의 컴플레인에 학생 B 의 환불을 이으면 A 의 이력에 B 의 돈이 선다 — 강사 교체(CR-BE-02)와 같은 말로 거절한다.
     * 마무리한 건은 받지 않는다 — §67 「수강 종료 · 환불」 단추가 서는 조건(canWithdraw · 열린 건)과 같은 질문이다(D-R39).
     */
    const cplId = dto.cplId ?? null;
    if (cplId !== null) {
      const [c] = (await m.query(`SELECT id, stage, student_id FROM cpl WHERE id = $1 FOR UPDATE`, [cplId])) as Array<{ id: string; stage: string; student_id: string | null }>;
      if (!c) throw new NotFoundException({ code: 'CPL_NOT_FOUND', message: '컴플레인을 찾을 수 없습니다' });
      if (c.student_id == null || Number(c.student_id) !== dto.studentId) {
        throw new BadRequestException({
          code: 'CPL_STUDENT_MISMATCH',
          message: `컴플레인 #${cplId} 의 학생과 종료할 학생이 다릅니다 — 컴플레인에서 연 환불은 그 컴플레인의 학생만 처리합니다`,
        });
      }
      if (!CPL_OPEN_STAGES.includes(c.stage as CplStage)) {
        throw new ConflictException({ code: 'CPL_CLOSED', message: `컴플레인 #${cplId} 은(는) 이미 마무리됐습니다 — 새로 접수한 뒤 환불을 이으세요` });
      }
    }
    // 마감 달의 명단·청구를 바꾸는 일이다 — 종료일이 마감 달이면 409 (C92-d 와 같은 판정)
    await assertMonthOpen(m, dto.endedOn);

    /* ── 종료할 규칙 — 그 학생이 들어 있고 종료일 뒤에도 유효한 명단 행 ── */
    const params: unknown[] = [dto.studentId, dto.endedOn];
    if (dto.serIds) params.push(dto.serIds);
    const series = (await m.query(
      `SELECT ss.ser_id, s.kind_key, s.sub_key, s.title, to_char(ss.to_date, 'YYYY-MM-DD') AS to_date
         FROM ser_stu ss JOIN ser s ON s.id = ss.ser_id
        WHERE ss.student_id = $1
          AND (ss.to_date IS NULL OR ss.to_date > $2::date)
          AND (s.to_date IS NULL OR s.to_date > $2::date)
          ${dto.serIds ? 'AND ss.ser_id = ANY($3::bigint[])' : ''}
        ORDER BY ss.ser_id
        FOR UPDATE OF ss`,
      params,
    )) as SeriesRow[];
    if (dto.serIds && series.length !== dto.serIds.length) {
      throw new BadRequestException({ code: 'WITHDRAW_BAD_SERIES', message: '이 학생이 들어 있지 않거나 이미 끝난 규칙이 섞여 있습니다' });
    }
    if (!series.length) {
      throw new ConflictException({ code: 'WITHDRAW_NOTHING', message: '종료할 수강이 없습니다 — 그 날 뒤에 이 학생이 든 규칙이 없습니다' });
    }
    const serIds = series.map((r) => Number(r.ser_id));

    /* ── ① 종료일 뒤 회차 — 규칙마다 몇 회, 청구서마다 얼마 (명단을 바꾸기 **전에** 센다) ── */
    const remaining = (await m.query(
      `SELECT o.ser_id, count(*)::int AS n
         FROM ser_occ o
        WHERE o.ser_id = ANY($1::bigint[]) AND o.on_date > $2::date AND NOT o.canceled
          AND NOT EXISTS (SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                           WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND xo.student_id = $3)
        GROUP BY o.ser_id`,
      [serIds, dto.endedOn, dto.studentId],
    )) as Array<{ ser_id: string; n: number }>;
    const remainingOf = new Map(remaining.map((r) => [Number(r.ser_id), Number(r.n)]));

    /*
     * 종료일 뒤 회차가 들어 있을 수 있는 청구서 — **회차로 센 종류**(수업료 · 진단고사 + 상담 · N-75) · 취소 아님 · 종료일의 달부터.
     * 잔여 회차 값은 그 청구서의 종류가 세는 회차로만 센다 — 발행과 같은 함수 · 같은 종류(수업료 줄에는 진단고사 · 상담이 없다).
     */
    const invoices = (await m.query(
      `SELECT id, year_month, inv_type, title, state::text AS state, amount, paid_amount, sent_at
         FROM inv
        WHERE student_id = $1 AND inv_type IN ('tuition', 'diag_intake') AND state <> 'void' AND year_month >= $2
        ORDER BY year_month, id
        FOR UPDATE`,
      [dto.studentId, dto.endedOn.slice(0, 7)],
    )) as InvRow[];
    const afterLines = new Map<number, InvoiceLineRow[]>();
    for (const inv of invoices) {
      const after = { kind: 'after', after: dto.endedOn, serIds } as const;
      afterLines.set(Number(inv.id), await invoiceLines(m, dto.studentId, inv.year_month, after, inv.inv_type));
      /*
       * 옛 수업료 청구서(N-75 전)에 진단고사 · 상담 회차의 줄이 섞여 있고 **그 회차가 종료일 뒤에 남아 있으면** 멈춘다 (W11 A' 후속).
       * 지금 계산은 그 회차를 수업료에서 빼므로 그대로 두면 환불 몫이 조용히 줄어든다 — 저장된 줄을 고쳐 읽지 않고 사람이 확인한다.
       * 그 회차가 종료일 전이거나 범위(「이 수업만」)에서 빠지면 환불 몫이 달라지지 않아 멈추지 않는다. 아무것도 쓰기 전이다.
       */
      if (inv.inv_type === 'tuition' && (await mixedDiagIntakeLines(m, Number(inv.id))).length > 0
        && (await invoiceLines(m, dto.studentId, inv.year_month, after, 'diag_intake')).length > 0) {
        throw new ConflictException({ code: 'WITHDRAW_MIXED_INVOICE', message: withdrawMixedMessage(inv.year_month) });
      }
    }

    /* ── ② 명단에 종료일 — 행은 남는다 (N-50 ①) ── */
    await m.query(`UPDATE ser_stu SET to_date = $2::date WHERE student_id = $1 AND ser_id = ANY($3::bigint[])`, [dto.studentId, dto.endedOn, serIds]);

    /* ── ③ 청구서 — 잔여 회차 줄을 빼고 넘친 돈은 환불 줄로 ── */
    const invOut: WithdrawInvoiceDto[] = [];
    let refundTotal = 0;
    /** 대표만 할 수 있는 취소가 걸리는 청구서 — 미리보기가 그 달을 이름으로 말한다 */
    const needsCeoVoid: string[] = [];
    for (const inv of invoices) {
      const invId = Number(inv.id);
      const lines = afterLines.get(invId) ?? [];
      const removed = lines.reduce((n, l) => n + l.n, 0);
      if (removed === 0) continue;
      if (lines.some((l) => l.unit_price === null)) {
        throw new ConflictException({
          code: 'WITHDRAW_NO_RATE',
          message: `${inv.year_month} 청구서의 잔여 회차에 단가 없는 과목이 있습니다 — 단가를 먼저 등록하세요`,
        });
      }
      const delta = linesTotal(lines);
      const amountBefore = Number(inv.amount);
      const amountAfter = amountBefore - delta;
      if (amountAfter < 0) {
        // 이월 음수 줄 등으로 청구서가 이미 작아져 있다 — 넘어서 빼지 않는다(장부가 음수가 되면 안 된다)
        throw new ConflictException({ code: 'WITHDRAW_EXCEEDS', message: `${inv.year_month} 청구서 금액보다 잔여 회차 값이 큽니다 — 청구서를 먼저 확인하세요` });
      }
      const paid = Number(inv.paid_amount);
      const refund = Math.max(0, paid - amountAfter);
      const [{ seq }] = (await m.query(`SELECT COALESCE(max(seq), -1)::int + 1 AS seq FROM inv_line WHERE inv_id = $1`, [invId])) as Array<{ seq: number }>;
      let i = 0;
      for (const l of lines) {
        await m.query(
          `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [invId, l.sub_key, `수강 종료 · ${l.label}`.slice(0, 80), -l.n, Number(l.unit_price), -(l.n * Number(l.unit_price)), Number(seq) + i++],
        );
      }
      if (refund > 0) {
        await m.query(
          `INSERT INTO pay (inv_id, student_id, amount, paid_on, method, reason, entered_by, entered_at, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4::date, 'transfer', $5, $6, now(), $6, now())`,
          [invId, dto.studentId, -refund, today, `수강 종료 환불 · 잔여 ${removed}회${reason ? ` · ${reason}` : ''}`.slice(0, 200), userId],
        );
      }
      const paidAfter = paid - refund;
      const voided = amountAfter === 0;
      if (voided && !canVoidInvoice) {
        // 미리보기는 던지지 않는다 — 화면이 「왜 못 누르는지」를 먼저 말해야 한다
        if (!preview) {
          throw new ConflictException({
            code: 'WITHDRAW_NEEDS_CEO_VOID',
            message: `${inv.year_month} 청구서가 통째로 비어 취소(void)됩니다 — 청구서 취소는 대표만 할 수 있습니다`,
          });
        }
        needsCeoVoid.push(inv.year_month);
      }
      await m.query(
        `UPDATE inv
            SET amount = $2::int, paid_amount = $3::int,
                state = CASE WHEN $4::boolean THEN 'void'::inv_state_t
                             WHEN $3::int >= $2::int AND $2::int > 0 THEN 'paid'::inv_state_t
                             WHEN $3::int > 0 THEN 'partial'::inv_state_t
                             WHEN sent_at IS NOT NULL THEN 'sent'::inv_state_t
                             ELSE state END,
                paid_at = CASE WHEN NOT $4::boolean AND $3::int >= $2::int AND $2::int > 0 THEN COALESCE(paid_at, now()) ELSE NULL END,
                detail = CASE WHEN $4::boolean THEN COALESCE(detail, '{}'::jsonb)
                                 || jsonb_build_object('void', jsonb_build_object('reason', '수강 종료 — 잔여 회차뿐이라 청구할 것이 없다', 'by', $5::bigint, 'at', now()))
                              ELSE detail END
          WHERE id = $1`,
        [invId, amountAfter, paidAfter, voided, userId],
      );
      // 분납 일정(N-79)이 있으면 합 = 새 청구액이 되게 **끝 회차부터** 줄인다 — 빠진 것은 종료일 뒤(뒤쪽) 회차다 (표의 지연 제약이 커밋 때 합을 본다)
      const installments = await this.shrinkInstallments(m, invId, amountBefore - amountAfter);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'INV',$2,'withdraw',$3::jsonb,$4::jsonb)`,
        [userId, invId,
          JSON.stringify({ amount: amountBefore, paid, state: inv.state }),
          JSON.stringify({
            amount: amountAfter, paid: paidAfter, refund, removed, voided, endedOn: dto.endedOn,
            lines: lines.map((l) => `${l.label} −${l.n}×${l.unit_price}`),
            ...(installments ? { installments } : {}),
          })],
      );
      refundTotal += refund;
      const [after] = (await m.query(`SELECT state::text AS state FROM inv WHERE id = $1`, [invId])) as Array<{ state: string }>;
      invOut.push({
        id: invId, yearMonth: inv.year_month, title: inv.title, state: after.state,
        amountBefore: money(amountBefore), amountAfter: money(amountAfter), paidAmount: money(paidAfter), refund: money(refund),
        removedCount: removed, voided, needsCeoVoid: voided && !canVoidInvoice,
      });
    }

    /* ── ④ 수강(ENR) 종료일 · LOG ── */
    const pairs = series.map((r) => [r.kind_key, r.sub_key] as const);
    let enrollmentsEnded = 0;
    for (const [kind, sub] of pairs) {
      // TypeORM 의 query() 는 UPDATE … RETURNING 에서 [rows, affected] 를 준다 — `writtenRows` 한 곳이 푼다 (C85-a)
      const rows = writtenRows<{ id: string }>(await m.query(
        `UPDATE enr SET ended_on = $2::date
          WHERE student_id = $1 AND ended_on IS NULL AND kind_key = $3 AND sub_key IS NOT DISTINCT FROM $4::varchar
          RETURNING id`,
        [dto.studentId, dto.endedOn, kind, sub],
      ));
      enrollmentsEnded += rows.length;
    }
    const seriesOut: WithdrawSeriesDto[] = series.map((r) => ({
      serId: Number(r.ser_id), kindKey: r.kind_key, subKey: r.sub_key, title: r.title,
      endedOn: dto.endedOn, remainingCount: remainingOf.get(Number(r.ser_id)) ?? 0,
    }));
    const remainingCount = seriesOut.reduce((n, r) => n + r.remainingCount, 0);
    await m.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'STU',$2,'withdraw',NULL,$3::jsonb)`,
      [userId, dto.studentId, JSON.stringify({ endedOn: dto.endedOn, serIds, remainingCount, refundTotal, invoices: invOut.map((i) => i.id), reason, enrollmentsEnded, cplId })],
    );
    if (cplId !== null) {
      // 컴플레인 쪽 감사 줄 — §67 컴플레인 이력이 이 줄을 읽어 「환불 N원」을 세운다(모양은 lib/complaint-words.CPL_REFUND_LOG 의 계약)
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,NULL,$5::jsonb)`,
        [userId, CPL_REFUND_LOG.entity, cplId, CPL_REFUND_LOG.action,
          JSON.stringify({ studentId: dto.studentId, endedOn: dto.endedOn, refundTotal, invoices: invOut.map((i) => i.id), serIds, reason })],
      );
    }

    const result: WithdrawResultDto = {
      studentId: Number(stu.id), studentName: stu.name, endedOn: dto.endedOn, reason, preview, cplId,
      series: seriesOut, invoices: invOut, remainingCount, refundTotal: money(refundTotal), enrollmentsEnded, canSeeAmounts,
      canConfirm: needsCeoVoid.length === 0,
      confirmBlockedReason: needsCeoVoid.length === 0 ? null
        : `${needsCeoVoid.join(' · ')} 청구서가 통째로 비어 취소됩니다 — 청구서 취소는 대표만 할 수 있습니다`,
    };
    if (preview) throw new PreviewRollback(result);
    return result;
  }

  /**
   * 청구액이 `cut` 만큼 줄 때 분납 일정을 **끝 회차부터** 줄인다(0 이 된 회차는 지운다) — 합 = 새 청구액.
   * 일정이 없으면 null. 돌려주는 값은 LOG 에 남길 새 일정(회차 · 금액)이다.
   */
  private async shrinkInstallments(m: EntityManager, invId: number, cut: number): Promise<Array<{ seq: number; amount: number }> | null> {
    const rows = (await m.query(
      `SELECT id, seq, amount FROM inv_installment WHERE inv_id = $1 ORDER BY seq DESC FOR UPDATE`, [invId],
    )) as Array<{ id: string; seq: number; amount: number }>;
    if (!rows.length) return null;
    let left = cut;
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(Number(r.amount), left);
      left -= take;
      if (take === Number(r.amount)) await m.query(`DELETE FROM inv_installment WHERE id = $1`, [r.id]);
      else await m.query(`UPDATE inv_installment SET amount = amount - $2 WHERE id = $1`, [r.id, take]);
    }
    const now = (await m.query(`SELECT seq, amount FROM inv_installment WHERE inv_id = $1 ORDER BY seq`, [invId])) as Array<{ seq: number; amount: number }>;
    return now.map((r) => ({ seq: Number(r.seq), amount: Number(r.amount) }));
  }
}
