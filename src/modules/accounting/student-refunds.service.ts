/** @file-guide
 * 목적: BOC-11D-02 승인 청구 조정의 환불 예정 증가분을 실제 지급·취소·재지급 원장으로 보존한다.
 * 책임/재사용: 환불 금액·source version·보호 계좌 snapshot·멱등·감사는 이 서비스와 migration이 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D2-STUDENT-REFUND-DISBURSEMENT-2026-10-09.md · migration 1768500000000
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { todayKst } from '../../lib/kst';
import { studentTagSql } from '../../lib/student-label';
import type {
  StudentRefundCancelDto, StudentRefundDto, StudentRefundEventDto, StudentRefundLedgerDto,
  StudentRefundPayDto, StudentRefundState,
} from './accounting.dto';

type Row = Record<string, unknown>;
type RefundAction = 'paid' | 'canceled';

const KIND_LABEL: Record<string, string> = {
  discount: '할인', refund: '환불', sibling_discount: '형제 할인', carry: '이월',
};
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown): string | null => value == null ? null : new Date(String(value)).toISOString();

const BASE_SELECT = `SELECT a.id AS adjustment_id,a.inv_id,a.student_id,a.year_month,
  to_char(a.effective_on,'YYYY-MM-DD') AS effective_on,a.kind,a.reason,a.row_version AS source_adjustment_version,
  s.name AS student_name,${studentTagSql('s')} AS student_tag,
  GREATEST(0,i.paid_amount-e.invoice_amount_after)-GREATEST(0,i.paid_amount-e.invoice_amount_before) AS refund_amount,
  d.id AS disbursement_id,d.state AS disbursement_state,d.row_version AS disbursement_version,
  to_char(d.paid_on,'YYYY-MM-DD') AS paid_on,d.method,d.paid_by,d.canceled_at,d.cancel_reason,
  d.account_id,d.account_version,d.account_last4,pb.name AS paid_by_name,
  pa.id AS active_account_id,pa.row_version AS active_account_version,pa.last4 AS active_account_last4
 FROM invoice_adjustment a
 JOIN invoice_adjustment_event e ON e.invoice_adjustment_id=a.id
   AND e.result_version=a.row_version AND e.to_state='approved'
 JOIN inv i ON i.id=a.inv_id
 JOIN stu s ON s.id=a.student_id
 LEFT JOIN student_refund_disbursement d ON d.invoice_adjustment_id=a.id
 LEFT JOIN staff pb ON pb.id=d.paid_by
 LEFT JOIN protected_account pa ON pa.purpose='student_refund' AND pa.target_id=a.student_id AND pa.state='active'
 WHERE a.state='approved'
   AND GREATEST(0,i.paid_amount-e.invoice_amount_after)-GREATEST(0,i.paid_amount-e.invoice_amount_before)>0`;

@Injectable()
export class StudentRefundsService {
  constructor(private readonly ds: DataSource) {}

  private async events(q: DataSource | EntityManager, ids: number[]): Promise<Map<number, StudentRefundEventDto[]>> {
    const map = new Map<number, StudentRefundEventDto[]>();
    if (!ids.length) return map;
    const rows = await q.query(`SELECT d.invoice_adjustment_id,e.action,e.from_state,e.to_state,e.result_version,
        e.amount,e.source_adjustment_version,e.paid_on,e.method,e.reason,e.account_id,e.account_version,e.account_last4,
        e.created_at,s.name AS actor_name
      FROM student_refund_disbursement_event e
      JOIN student_refund_disbursement d ON d.id=e.student_refund_disbursement_id
      JOIN staff s ON s.id=e.actor_id
      WHERE d.invoice_adjustment_id=ANY($1::bigint[])
      ORDER BY d.invoice_adjustment_id,e.result_version`, [ids]) as Row[];
    for (const row of rows) {
      const adjustmentId = Number(row.invoice_adjustment_id);
      const bucket = map.get(adjustmentId) ?? [];
      bucket.push({
        action: String(row.action) as RefundAction,
        fromState: row.from_state == null ? null : String(row.from_state) as 'paid' | 'canceled',
        toState: String(row.to_state) as 'paid' | 'canceled', version: Number(row.result_version),
        amount: Number(row.amount), sourceAdjustmentVersion: Number(row.source_adjustment_version),
        actor: String(row.actor_name), paidOn: row.paid_on == null ? null : String(row.paid_on),
        method: row.method == null ? null : 'bank_transfer', reason: row.reason == null ? null : String(row.reason),
        accountId: row.account_id == null ? null : Number(row.account_id),
        accountVersion: row.account_version == null ? null : Number(row.account_version),
        accountLast4: row.account_last4 == null ? null : String(row.account_last4),
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
      map.set(adjustmentId, bucket);
    }
    return map;
  }

  private shape(row: Row, canWrite: boolean, history: StudentRefundEventDto[]): StudentRefundDto {
    const state = row.disbursement_state == null ? 'unpaid' : String(row.disbursement_state) as StudentRefundState;
    const accountReady = row.active_account_id != null;
    return {
      adjustmentId: Number(row.adjustment_id), invoiceId: Number(row.inv_id), studentId: Number(row.student_id),
      studentName: String(row.student_name), studentTag: row.student_tag == null ? null : String(row.student_tag),
      yearMonth: String(row.year_month), effectiveOn: String(row.effective_on),
      adjustmentKindLabel: KIND_LABEL[String(row.kind)] ?? String(row.kind), adjustmentReason: String(row.reason),
      amount: Number(row.refund_amount), sourceAdjustmentVersion: Number(row.source_adjustment_version),
      status: state, version: row.disbursement_version == null ? 0 : Number(row.disbursement_version),
      accountReady, activeAccountLast4: row.active_account_last4 == null ? null : String(row.active_account_last4),
      accountId: row.account_id == null ? null : Number(row.account_id),
      accountVersion: row.account_version == null ? null : Number(row.account_version),
      accountLast4: row.account_last4 == null ? null : String(row.account_last4),
      paidOn: row.paid_on == null ? null : String(row.paid_on), method: row.method == null ? null : 'bank_transfer',
      paidBy: row.paid_by_name == null ? null : String(row.paid_by_name),
      canceledAt: iso(row.canceled_at), cancelReason: row.cancel_reason == null ? null : String(row.cancel_reason),
      canPay: canWrite && state !== 'paid' && accountReady,
      canCancel: canWrite && state === 'paid', events: history,
    };
  }

  private async one(q: DataSource | EntityManager, adjustmentId: number, canWrite: boolean): Promise<StudentRefundDto> {
    const [row] = await q.query(`${BASE_SELECT} AND a.id=$1`, [adjustmentId]) as Row[];
    if (!row) {
      throw new ConflictException({
        code: 'STUDENT_REFUND_NOT_DUE', message: '현재 승인 상태에서 실제 지급할 환불 예정액이 없습니다',
      });
    }
    const history = await this.events(q, [adjustmentId]);
    return this.shape(row, canWrite, history.get(adjustmentId) ?? []);
  }

  async ledger(canWrite: boolean, month?: string): Promise<StudentRefundLedgerDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '학생 환불 원장을 조회할 권한이 없습니다' });
    const targetMonth = month ?? todayKst().slice(0, 7);
    const rows = await this.ds.query(`${BASE_SELECT} AND a.year_month=$1 ORDER BY a.effective_on DESC,a.id DESC`, [targetMonth]) as Row[];
    const history = await this.events(this.ds, rows.map((row) => Number(row.adjustment_id)));
    const items = rows.map((row) => this.shape(row, canWrite, history.get(Number(row.adjustment_id)) ?? []));
    const paid = items.filter((item) => item.status === 'paid');
    return {
      month: targetMonth, totalCount: items.length,
      totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
      paidCount: paid.length, paidAmount: paid.reduce((sum, item) => sum + item.amount, 0),
      unpaidAmount: items.filter((item) => item.status !== 'paid').reduce((sum, item) => sum + item.amount, 0),
      canWrite, items,
    };
  }

  private async lockRequest(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('student-refund'),hashtext($1))`, [requestKey]);
  }

  private async replay(
    m: EntityManager, requestKey: string, actorId: number, action: RefundAction, adjustmentId: number, fingerprint: string,
  ): Promise<StudentRefundDto | null> {
    const [prior] = await m.query(`SELECT actor_id,action,invoice_adjustment_id,payload_sha256,result_version
      FROM student_refund_disbursement_request WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action
      || Number(prior.invoice_adjustment_id) !== adjustmentId || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'STUDENT_REFUND_KEY_REUSED', message: '같은 요청 키를 다른 학생 환불 작업에 사용할 수 없습니다',
      });
    }
    const [receipt] = await m.query(`SELECT e.result_version,e.to_state,d.row_version,d.state
      FROM student_refund_disbursement_event e
      JOIN student_refund_disbursement d ON d.id=e.student_refund_disbursement_id
      WHERE e.request_key=$1`, [requestKey]) as Row[];
    if (!receipt || Number(receipt.result_version) !== Number(receipt.row_version) || receipt.to_state !== receipt.state) {
      throw new ConflictException({
        code: 'STUDENT_REFUND_REPLAY_STALE', message: '이 요청 뒤에 환불 상태가 바뀌었습니다 — 현재 원장을 다시 확인해 주세요',
      });
    }
    return this.one(m, adjustmentId, true);
  }

  private stale(expectedVersion: number, actualVersion: number): never {
    throw new ConflictException({
      code: 'STUDENT_REFUND_STALE', message: '학생 환불 상태가 바뀌었습니다 — 다시 불러와 주세요',
      details: { expectedVersion, actualVersion },
    });
  }

  async pay(actorId: number, canWrite: boolean, adjustmentId: number, dto: StudentRefundPayDto): Promise<StudentRefundDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '학생 환불을 지급할 권한이 없습니다' });
    if (dto.paidOn > todayKst()) {
      throw new BadRequestException({
        code: 'STUDENT_REFUND_PAYMENT_FUTURE', message: '미래 날짜로 학생 환불 지급을 기록할 수 없습니다',
      });
    }
    const fingerprint = sha({ adjustmentId, expectedVersion: dto.expectedVersion, paidOn: dto.paidOn, method: dto.method });
    return this.ds.transaction(async (m) => {
      await this.lockRequest(m, dto.requestKey);
      const prior = await this.replay(m, dto.requestKey, actorId, 'paid', adjustmentId, fingerprint);
      if (prior) return prior;
      const source = await this.one(m, adjustmentId, true);
      const [lockedSource] = await m.query(`SELECT id,row_version,state FROM invoice_adjustment WHERE id=$1 FOR UPDATE`, [adjustmentId]) as Row[];
      if (!lockedSource || String(lockedSource.state) !== 'approved'
        || Number(lockedSource.row_version) !== source.sourceAdjustmentVersion) {
        throw new ConflictException({ code: 'STUDENT_REFUND_NOT_DUE', message: '현재 승인 상태에서 실제 지급할 환불 예정액이 없습니다' });
      }
      const [account] = await m.query(`SELECT id,row_version,last4 FROM protected_account
        WHERE purpose='student_refund' AND target_id=$1 AND state='active' FOR SHARE`, [source.studentId]) as Row[];
      if (!account) {
        throw new ConflictException({
          code: 'STUDENT_REFUND_ACCOUNT_REQUIRED', message: '활성 학생 환불 계좌를 먼저 등록해 주세요',
          details: { studentId: source.studentId },
        });
      }
      const [current] = await m.query(`SELECT id,state,row_version FROM student_refund_disbursement
        WHERE invoice_adjustment_id=$1 FOR UPDATE`, [adjustmentId]) as Row[];
      const actualVersion = current ? Number(current.row_version) : 0;
      if (dto.expectedVersion !== actualVersion) this.stale(dto.expectedVersion, actualVersion);
      if (current?.state === 'paid') {
        throw new ConflictException({ code: 'STUDENT_REFUND_ALREADY_PAID', message: '이미 지급 완료한 학생 환불입니다' });
      }
      const nextVersion = actualVersion + 1;
      let disbursementId: number;
      if (!current) {
        const [made] = await m.query(`INSERT INTO student_refund_disbursement(
            invoice_adjustment_id,state,row_version,amount,source_adjustment_version,paid_on,method,paid_by,paid_at,
            account_id,account_version,account_last4)
          VALUES($1,'paid',1,$2,$3,$4,$5,$6,now(),$7,$8,$9) RETURNING id`, [
          adjustmentId, source.amount, source.sourceAdjustmentVersion, dto.paidOn, dto.method, actorId,
          account.id, account.row_version, account.last4,
        ]) as Row[];
        disbursementId = Number(made.id);
      } else {
        disbursementId = Number(current.id);
        await m.query(`UPDATE student_refund_disbursement SET state='paid',row_version=$2,amount=$3,
          source_adjustment_version=$4,paid_on=$5,method=$6,paid_by=$7,paid_at=now(),account_id=$8,
          account_version=$9,account_last4=$10,canceled_by=NULL,canceled_at=NULL,cancel_reason=NULL WHERE id=$1`, [
          disbursementId, nextVersion, source.amount, source.sourceAdjustmentVersion, dto.paidOn, dto.method, actorId,
          account.id, account.row_version, account.last4,
        ]);
      }
      await m.query(`INSERT INTO student_refund_disbursement_request(
          request_key,actor_id,action,invoice_adjustment_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,'paid',$3,$4,$5,$6)`, [
        dto.requestKey, actorId, adjustmentId, dto.expectedVersion, fingerprint, nextVersion,
      ]);
      await m.query(`INSERT INTO student_refund_disbursement_event(
          student_refund_disbursement_id,action,from_state,to_state,actor_id,request_key,result_version,amount,
          source_adjustment_version,paid_on,method,account_id,account_version,account_last4)
        VALUES($1,'paid',$2,'paid',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        disbursementId, current?.state ?? null, actorId, dto.requestKey, nextVersion, source.amount,
        source.sourceAdjustmentVersion, dto.paidOn, dto.method, account.id, account.row_version, account.last4,
      ]);
      // 계좌 원문은 LOG에 남기지 않는다. 지급 당시 id/version/뒤4자리와 source version만 감사한다.
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'STUDENT_REFUND',$2,'paid',$3::jsonb,$4::jsonb)`, [
        actorId, disbursementId,
        current ? JSON.stringify({ adjustmentId, state: current.state, version: actualVersion }) : null,
        JSON.stringify({ adjustmentId, state: 'paid', version: nextVersion, amount: source.amount,
          sourceAdjustmentVersion: source.sourceAdjustmentVersion, paidOn: dto.paidOn, method: dto.method,
          accountId: Number(account.id), accountVersion: Number(account.row_version), accountLast4: String(account.last4) }),
      ]);
      return this.one(m, adjustmentId, true);
    });
  }

  async cancel(
    actorId: number, canWrite: boolean, adjustmentId: number, dto: StudentRefundCancelDto,
  ): Promise<StudentRefundDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '학생 환불 지급을 취소할 권한이 없습니다' });
    const reason = dto.reason.trim();
    const fingerprint = sha({ adjustmentId, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await this.lockRequest(m, dto.requestKey);
      const prior = await this.replay(m, dto.requestKey, actorId, 'canceled', adjustmentId, fingerprint);
      if (prior) return prior;
      const [current] = await m.query(`SELECT d.* FROM student_refund_disbursement d
        WHERE d.invoice_adjustment_id=$1 FOR UPDATE`, [adjustmentId]) as Row[];
      if (!current || String(current.state) !== 'paid') {
        throw new ConflictException({ code: 'STUDENT_REFUND_NOT_PAID', message: '지급 완료 상태의 학생 환불만 취소할 수 있습니다' });
      }
      const actualVersion = Number(current.row_version);
      if (dto.expectedVersion !== actualVersion) this.stale(dto.expectedVersion, actualVersion);
      const nextVersion = actualVersion + 1;
      await m.query(`UPDATE student_refund_disbursement SET state='canceled',row_version=$2,
        canceled_by=$3,canceled_at=now(),cancel_reason=$4 WHERE id=$1`, [current.id, nextVersion, actorId, reason]);
      await m.query(`INSERT INTO student_refund_disbursement_request(
          request_key,actor_id,action,invoice_adjustment_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,'canceled',$3,$4,$5,$6)`, [
        dto.requestKey, actorId, adjustmentId, dto.expectedVersion, fingerprint, nextVersion,
      ]);
      await m.query(`INSERT INTO student_refund_disbursement_event(
          student_refund_disbursement_id,action,from_state,to_state,actor_id,request_key,result_version,amount,
          source_adjustment_version,reason,account_id,account_version,account_last4)
        VALUES($1,'canceled','paid','canceled',$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        current.id, actorId, dto.requestKey, nextVersion, current.amount, current.source_adjustment_version, reason,
        current.account_id, current.account_version, current.account_last4,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'STUDENT_REFUND',$2,'canceled',$3::jsonb,$4::jsonb)`, [
        actorId, current.id, JSON.stringify({ adjustmentId, state: 'paid', version: actualVersion }),
        JSON.stringify({ adjustmentId, state: 'canceled', version: nextVersion, reason }),
      ]);
      return this.one(m, adjustmentId, true);
    });
  }
}
