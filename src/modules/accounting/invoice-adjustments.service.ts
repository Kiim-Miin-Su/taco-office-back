/** @file-guide
 * 목적: BO-11BD-01 청구 조정의 신청·대표 승인·반려·반영 취소·되돌리기를 INV/current/event 원장에 원자적으로 반영한다.
 * 책임/재사용: 회계 권한은 controller, 상태·금액·월마감·멱등·감사·알림은 이 서비스와 migration이 최종 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11BD01-INVOICE-ADJUSTMENT-APPROVAL-2026-10-09.md · migration 1768200000000
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { assertMonthOpenForWrite } from '../../lib/month-close';
import { NOTI_TITLE } from '../../lib/noti';
import { studentTagSql } from '../../lib/student-label';
import { todayKst } from '../../lib/kst';
import type {
  InvoiceAdjustmentActionDto, InvoiceAdjustmentCreateDto, InvoiceAdjustmentDto, InvoiceAdjustmentEventDto,
  InvoiceAdjustmentKind, InvoiceAdjustmentLedgerDto, InvoiceAdjustmentReasonActionDto, InvoiceAdjustmentState,
  InvoiceAdjustmentWriteResultDto,
} from './accounting.dto';

type Row = Record<string, unknown>;
type AdjustmentAction = 'created' | 'approved' | 'rejected' | 'canceled' | 'restored';
type TransitionAction = 'approve' | 'reject' | 'cancel' | 'undo';

const KIND_LABEL: Record<InvoiceAdjustmentKind, string> = {
  discount: '할인', refund: '환불', sibling_discount: '형제 할인', carry: '이월',
};
const STATE_LABEL: Record<InvoiceAdjustmentState, string> = {
  pending: '승인 대기', approved: '승인·반영', rejected: '반려', canceled: '반영 취소',
};
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown): string | null => value == null ? null : new Date(String(value)).toISOString();

const BASE_SELECT = `SELECT a.id,a.inv_id,a.student_id,a.year_month,to_char(a.effective_on,'YYYY-MM-DD') AS effective_on,
  a.kind,a.reason,a.amount,a.state,a.row_version,a.requested_by,a.requested_at,a.decided_at,a.reject_reason,a.canceled_at,a.cancel_reason,
  s.name AS student_name,${studentTagSql('s')} AS student_tag,
  rq.name AS requested_by_name,dc.name AS decided_by_name,cc.name AS canceled_by_name,
  b.original_amount,i.amount AS invoice_amount,i.paid_amount,i.state AS invoice_state
 FROM invoice_adjustment a
 JOIN invoice_adjustment_base b ON b.inv_id=a.inv_id
 JOIN inv i ON i.id=a.inv_id
 JOIN stu s ON s.id=a.student_id
 JOIN staff rq ON rq.id=a.requested_by
 LEFT JOIN staff dc ON dc.id=a.decided_by
 LEFT JOIN staff cc ON cc.id=a.canceled_by`;

@Injectable()
export class InvoiceAdjustmentsService {
  constructor(private readonly ds: DataSource) {}

  private async lockRequestKey(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('invoice-adjustment'),hashtext($1))`, [requestKey]);
  }

  private async events(q: DataSource | EntityManager, ids: number[]): Promise<Map<number, InvoiceAdjustmentEventDto[]>> {
    const map = new Map<number, InvoiceAdjustmentEventDto[]>();
    if (!ids.length) return map;
    const rows = await q.query(`SELECT e.invoice_adjustment_id,e.action,e.from_state,e.to_state,e.result_version,
        e.actor_id,s.name AS actor_name,e.reason,e.invoice_amount_before,e.invoice_amount_after,e.created_at
      FROM invoice_adjustment_event e JOIN staff s ON s.id=e.actor_id
      WHERE e.invoice_adjustment_id=ANY($1::bigint[]) ORDER BY e.invoice_adjustment_id,e.result_version`, [ids]) as Row[];
    for (const row of rows) {
      const id = Number(row.invoice_adjustment_id);
      const bucket = map.get(id) ?? [];
      bucket.push({
        action: String(row.action) as InvoiceAdjustmentEventDto['action'],
        fromState: row.from_state == null ? null : String(row.from_state) as InvoiceAdjustmentState,
        toState: String(row.to_state) as InvoiceAdjustmentState,
        version: Number(row.result_version), actorId: Number(row.actor_id), actor: String(row.actor_name),
        reason: row.reason == null ? null : String(row.reason),
        invoiceAmountBefore: Number(row.invoice_amount_before), invoiceAmountAfter: Number(row.invoice_amount_after),
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
      map.set(id, bucket);
    }
    return map;
  }

  private shape(row: Row, canApprove: boolean, events: InvoiceAdjustmentEventDto[]): InvoiceAdjustmentDto {
    const state = String(row.state) as InvoiceAdjustmentState;
    const invoiceAmount = Number(row.invoice_amount);
    const paidAmount = Number(row.paid_amount);
    return {
      id: Number(row.id), invoiceId: Number(row.inv_id), studentId: Number(row.student_id),
      studentName: String(row.student_name), studentTag: row.student_tag == null ? null : String(row.student_tag),
      yearMonth: String(row.year_month), effectiveOn: String(row.effective_on),
      kind: String(row.kind) as InvoiceAdjustmentKind,
      kindLabel: KIND_LABEL[String(row.kind) as InvoiceAdjustmentKind] ?? String(row.kind),
      reason: String(row.reason), amount: Number(row.amount), state, stateLabel: STATE_LABEL[state] ?? state,
      version: Number(row.row_version), originalInvoiceAmount: Number(row.original_amount), invoiceAmount, paidAmount,
      refundDue: Math.max(0, paidAmount - invoiceAmount),
      requestedById: Number(row.requested_by), requestedBy: String(row.requested_by_name),
      requestedAt: new Date(String(row.requested_at)).toISOString(),
      decidedBy: row.decided_by_name == null ? null : String(row.decided_by_name), decidedAt: iso(row.decided_at),
      rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
      canceledBy: row.canceled_by_name == null ? null : String(row.canceled_by_name), canceledAt: iso(row.canceled_at),
      cancelReason: row.cancel_reason == null ? null : String(row.cancel_reason),
      canApprove: canApprove && state === 'pending', canReject: canApprove && state === 'pending',
      canCancel: canApprove && state === 'approved', canUndo: canApprove && (state === 'rejected' || state === 'canceled'),
      events,
    };
  }

  private async one(q: DataSource | EntityManager, id: number, canApprove: boolean): Promise<InvoiceAdjustmentDto> {
    const [row] = await q.query(`${BASE_SELECT} WHERE a.id=$1`, [id]) as Row[];
    if (!row) throw new NotFoundException({ code: 'INVOICE_ADJUSTMENT_NOT_FOUND', message: '청구 조정을 찾을 수 없습니다' });
    const history = await this.events(q, [id]);
    return this.shape(row, canApprove, history.get(id) ?? []);
  }

  async ledger(month: string | undefined, canRequest: boolean, canApprove: boolean): Promise<InvoiceAdjustmentLedgerDto> {
    if (!canRequest) throw new ForbiddenException({ code: 'FORBIDDEN', message: '청구 조정 원장 권한이 없습니다' });
    const targetMonth = month ?? todayKst().slice(0, 7);
    const rows = await this.ds.query(`${BASE_SELECT} WHERE a.year_month=$1
      ORDER BY CASE a.state WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
        a.effective_on DESC,a.id DESC`, [targetMonth]) as Row[];
    const history = await this.events(this.ds, rows.map((row) => Number(row.id)));
    const items = rows.map((row) => this.shape(row, canApprove, history.get(Number(row.id)) ?? []));
    return {
      month: targetMonth, pendingCount: items.filter((item) => item.state === 'pending').length,
      approvedAmount: items.filter((item) => item.state === 'approved').reduce((sum, item) => sum + item.amount, 0),
      refundDue: items.reduce((sum, item) => sum + item.refundDue, 0), canRequest, canApprove, items,
    };
  }

  private async replay(
    m: EntityManager, requestKey: string, actorId: number, action: AdjustmentAction, fingerprint: string, canApprove: boolean,
  ): Promise<InvoiceAdjustmentWriteResultDto | null> {
    const [prior] = await m.query(`SELECT invoice_adjustment_id,actor_id,action,payload_sha256,result_version
      FROM invoice_adjustment_event WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'INVOICE_ADJUSTMENT_KEY_REUSED', message: '같은 청구 조정 요청 키를 다른 작업에 다시 사용할 수 없습니다',
      });
    }
    const item = await this.one(m, Number(prior.invoice_adjustment_id), canApprove);
    if (item.version !== Number(prior.result_version)) {
      throw new ConflictException({
        code: 'INVOICE_ADJUSTMENT_REPLAY_STALE', message: '재시도한 요청 뒤에 조정 상태가 바뀌었습니다 — 최신 원장을 확인하세요',
      });
    }
    return { item, replayed: true };
  }

  async create(
    actorId: number, canRequest: boolean, canApprove: boolean, dto: InvoiceAdjustmentCreateDto,
  ): Promise<InvoiceAdjustmentWriteResultDto> {
    if (!canRequest) throw new ForbiddenException({ code: 'FORBIDDEN', message: '청구 조정을 신청할 권한이 없습니다' });
    const reason = dto.reason.trim();
    if (reason.length < 2) {
      throw new BadRequestException({ code: 'INVOICE_ADJUSTMENT_REASON_REQUIRED', message: '조정 사유를 두 글자 이상 입력해 주세요' });
    }
    const month = dto.effectiveOn.slice(0, 7);
    const fingerprint = sha({ effectiveOn: dto.effectiveOn, kind: dto.kind, studentId: dto.studentId, reason, amount: dto.amount });
    return this.ds.transaction(async (m) => {
      // 권고안 잠금 순서: 월마감 공유 잠금 → requestKey → INV 행. 같은 순서를 모든 조정 writer가 사용한다.
      await assertMonthOpenForWrite(m, month);
      await this.lockRequestKey(m, dto.requestKey);
      const replay = await this.replay(m, dto.requestKey, actorId, 'created', fingerprint, canApprove);
      if (replay) return replay;
      const invoices = await m.query(`SELECT i.id,i.amount,i.paid_amount,i.state
        FROM inv i WHERE i.student_id=$1 AND i.year_month=$2 AND i.inv_type='tuition' AND i.state<>'void'
        ORDER BY i.id FOR UPDATE`, [dto.studentId, month]) as Row[];
      if (!invoices.length) {
        throw new NotFoundException({
          code: 'INVOICE_ADJUSTMENT_INVOICE_NOT_FOUND', message: '적용 월의 유효 수업료 청구서를 찾을 수 없습니다',
        });
      }
      if (invoices.length > 1) {
        throw new ConflictException({
          code: 'INVOICE_ADJUSTMENT_INVOICE_AMBIGUOUS', message: '적용 월에 유효 수업료 청구서가 둘 이상입니다 — 청구서를 먼저 정리해 주세요',
        });
      }
      const invoice = invoices[0]!;
      if (String(invoice.state) === 'draft') {
        throw new ConflictException({
          code: 'INVOICE_ADJUSTMENT_INVOICE_NOT_ISSUED', message: '학부모에게 안내한 수업료 청구서만 조정할 수 있습니다',
        });
      }
      await m.query(`INSERT INTO invoice_adjustment_base(inv_id,original_amount) VALUES($1,$2)
        ON CONFLICT(inv_id) DO NOTHING`, [invoice.id, invoice.amount]);
      const [made] = await m.query(`INSERT INTO invoice_adjustment
        (inv_id,student_id,year_month,effective_on,kind,reason,amount,requested_by)
        VALUES($1,$2,$3,$4::date,$5,$6,$7,$8) RETURNING id`,
      [invoice.id, dto.studentId, month, dto.effectiveOn, dto.kind, reason, dto.amount, actorId]) as Row[];
      const id = Number(made.id);
      await m.query(`INSERT INTO invoice_adjustment_event
        (invoice_adjustment_id,action,from_state,to_state,actor_id,request_key,payload_sha256,result_version,
         invoice_amount_before,invoice_amount_after)
        VALUES($1,'created',NULL,'pending',$2,$3,$4,1,$5,$5)`, [id, actorId, dto.requestKey, fingerprint, invoice.amount]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,after)
        VALUES($1,'INV_ADJUST',$2,'create',$3::jsonb)`, [actorId, id, JSON.stringify({
        invoiceId: Number(invoice.id), studentId: dto.studentId, yearMonth: month, effectiveOn: dto.effectiveOn,
        kind: dto.kind, reason, amount: dto.amount, state: 'pending', version: 1,
      })]);
      await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
        SELECT s.id,$1,$2,$3,$4,'request' FROM staff s
         WHERE s.active AND s.role<>'teacher' AND s.id<>$1 ORDER BY s.id`, [
        actorId, NOTI_TITLE.invoiceAdjustmentRequested,
        `${KIND_LABEL[dto.kind]} ${dto.amount.toLocaleString('ko-KR')}원 · 대표 승인 대기`,
        `/accounting?tab=adjustments&adjustment=${id}`,
      ]);
      return { item: await this.one(m, id, canApprove), replayed: false };
    });
  }

  private async preflightMonth(id: number): Promise<string> {
    const [row] = await this.ds.query(`SELECT year_month FROM invoice_adjustment WHERE id=$1`, [id]) as Row[];
    if (!row) throw new NotFoundException({ code: 'INVOICE_ADJUSTMENT_NOT_FOUND', message: '청구 조정을 찾을 수 없습니다' });
    return String(row.year_month);
  }

  private eventAction(action: TransitionAction, fromState: InvoiceAdjustmentState): AdjustmentAction {
    if (action === 'approve') return 'approved';
    if (action === 'reject') return 'rejected';
    if (action === 'cancel') return 'canceled';
    if (fromState === 'rejected' || fromState === 'canceled') return 'restored';
    throw new ConflictException({ code: 'INVOICE_ADJUSTMENT_INVALID_TRANSITION', message: '현재 상태에서는 되돌릴 수 없습니다' });
  }

  async transition(
    actorId: number, canApprove: boolean, id: number, action: TransitionAction,
    dto: InvoiceAdjustmentActionDto | InvoiceAdjustmentReasonActionDto,
  ): Promise<InvoiceAdjustmentWriteResultDto> {
    if (!canApprove) throw new ForbiddenException({ code: 'FORBIDDEN', message: '청구 조정을 승인·반려할 권한이 없습니다' });
    const reason = 'reason' in dto ? dto.reason.trim() : null;
    if ((action === 'reject' || action === 'cancel' || action === 'undo') && (!reason || reason.length < 2)) {
      throw new BadRequestException({ code: 'INVOICE_ADJUSTMENT_REASON_REQUIRED', message: '처리 사유를 두 글자 이상 입력해 주세요' });
    }
    const month = await this.preflightMonth(id);
    const eventAction = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'cancel' ? 'canceled' : 'restored';
    const fingerprint = sha({ id, action, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await assertMonthOpenForWrite(m, month);
      await this.lockRequestKey(m, dto.requestKey);
      const replay = await this.replay(m, dto.requestKey, actorId, eventAction, fingerprint, canApprove);
      if (replay) return replay;
      const [current] = await m.query(`SELECT a.*,i.amount AS invoice_amount,i.paid_amount,i.state AS invoice_state,i.sent_at
        FROM invoice_adjustment a JOIN inv i ON i.id=a.inv_id WHERE a.id=$1 FOR UPDATE OF a,i`, [id]) as Row[];
      if (!current) throw new NotFoundException({ code: 'INVOICE_ADJUSTMENT_NOT_FOUND', message: '청구 조정을 찾을 수 없습니다' });
      if (Number(current.row_version) !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'INVOICE_ADJUSTMENT_STALE', message: '다른 승인 결과가 있습니다 — 조정 원장을 다시 불러와 주세요',
        });
      }
      if (String(current.invoice_state) === 'void') {
        throw new ConflictException({ code: 'INVOICE_ADJUSTMENT_INVOICE_VOID', message: '취소된 청구서에는 조정을 반영할 수 없습니다' });
      }
      const fromState = String(current.state) as InvoiceAdjustmentState;
      const actualEventAction = this.eventAction(action, fromState);
      if (actualEventAction !== eventAction) {
        throw new ConflictException({ code: 'INVOICE_ADJUSTMENT_INVALID_TRANSITION', message: '현재 상태에서는 이 처리를 할 수 없습니다' });
      }
      const valid = action === 'approve' || action === 'reject'
        ? fromState === 'pending'
        : action === 'cancel'
          ? fromState === 'approved'
          : fromState === 'rejected' || fromState === 'canceled';
      if (!valid) {
        throw new ConflictException({
          code: 'INVOICE_ADJUSTMENT_INVALID_TRANSITION', message: `${STATE_LABEL[fromState]} 상태에서는 이 처리를 할 수 없습니다`,
        });
      }
      if (action === 'cancel') {
        const [paidRefund] = await m.query(`SELECT id FROM student_refund_disbursement
          WHERE invoice_adjustment_id=$1 AND state='paid'`, [id]) as Row[];
        if (paidRefund) {
          throw new ConflictException({
            code: 'STUDENT_REFUND_CANCEL_REQUIRED',
            message: '실제 지급한 학생 환불을 먼저 취소한 뒤 조정 반영을 취소해 주세요',
          });
        }
      }
      const before = Number(current.invoice_amount);
      const amount = Number(current.amount);
      const changesInvoice = action === 'approve' || action === 'cancel' || (action === 'undo' && fromState === 'canceled');
      const after = action === 'cancel' ? before + amount
        : action === 'approve' || (action === 'undo' && fromState === 'canceled') ? before - amount : before;
      if (changesInvoice && after < 0) {
        throw new ConflictException({
          code: 'INVOICE_ADJUSTMENT_EXCEEDS_INVOICE', message: '승인된 조정 합계가 청구 원금을 넘을 수 없습니다',
        });
      }
      if (changesInvoice) {
        await m.query(`UPDATE inv SET amount=$2,
          state=CASE WHEN paid_amount >= $2 THEN 'paid'::inv_state_t
                     WHEN paid_amount > 0 THEN 'partial'::inv_state_t
                     WHEN sent_at IS NOT NULL THEN 'sent'::inv_state_t ELSE 'unpaid'::inv_state_t END,
          paid_at=CASE WHEN paid_amount >= $2 THEN COALESCE(paid_at,now()) ELSE NULL END
          WHERE id=$1`, [current.inv_id, after]);
      }
      const nextVersion = dto.expectedVersion + 1;
      let toState: InvoiceAdjustmentState;
      if (action === 'approve') {
        toState = 'approved';
        await m.query(`UPDATE invoice_adjustment SET state='approved',row_version=$2,decided_by=$3,decided_at=now(),
          reject_reason=NULL,canceled_by=NULL,canceled_at=NULL,cancel_reason=NULL WHERE id=$1`, [id, nextVersion, actorId]);
      } else if (action === 'reject') {
        toState = 'rejected';
        await m.query(`UPDATE invoice_adjustment SET state='rejected',row_version=$2,decided_by=$3,decided_at=now(),
          reject_reason=$4,canceled_by=NULL,canceled_at=NULL,cancel_reason=NULL WHERE id=$1`, [id, nextVersion, actorId, reason]);
      } else if (action === 'cancel') {
        toState = 'canceled';
        await m.query(`UPDATE invoice_adjustment SET state='canceled',row_version=$2,canceled_by=$3,canceled_at=now(),cancel_reason=$4
          WHERE id=$1`, [id, nextVersion, actorId, reason]);
      } else if (fromState === 'canceled') {
        toState = 'approved';
        await m.query(`UPDATE invoice_adjustment SET state='approved',row_version=$2,canceled_by=NULL,canceled_at=NULL,cancel_reason=NULL
          WHERE id=$1`, [id, nextVersion]);
      } else {
        toState = 'pending';
        await m.query(`UPDATE invoice_adjustment SET state='pending',row_version=$2,decided_by=NULL,decided_at=NULL,reject_reason=NULL
          WHERE id=$1`, [id, nextVersion]);
      }
      await m.query(`INSERT INTO invoice_adjustment_event
        (invoice_adjustment_id,action,from_state,to_state,reason,actor_id,request_key,payload_sha256,result_version,
         invoice_amount_before,invoice_amount_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        id, actualEventAction, fromState, toState, reason, actorId, dto.requestKey, fingerprint, nextVersion, before, after,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'INV_ADJUST',$2,$3,$4::jsonb,$5::jsonb)`, [
        actorId, id, actualEventAction,
        JSON.stringify({ state: fromState, version: dto.expectedVersion, invoiceAmount: before }),
        JSON.stringify({ state: toState, version: nextVersion, invoiceAmount: after, reason }),
      ]);
      if (Number(current.requested_by) !== actorId) {
        const title = actualEventAction === 'approved' ? NOTI_TITLE.invoiceAdjustmentApproved
          : actualEventAction === 'rejected' ? NOTI_TITLE.invoiceAdjustmentRejected
            : actualEventAction === 'canceled' ? NOTI_TITLE.invoiceAdjustmentCanceled
              : NOTI_TITLE.invoiceAdjustmentRestored;
        await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category) VALUES($1,$2,$3,$4,$5,'request')`, [
          current.requested_by, actorId, title,
          `${KIND_LABEL[String(current.kind) as InvoiceAdjustmentKind]} ${amount.toLocaleString('ko-KR')}원 · ${STATE_LABEL[toState]}`,
          `/accounting?tab=adjustments&adjustment=${id}`,
        ]);
      }
      return { item: await this.one(m, id, canApprove), replayed: false };
    });
  }
}
