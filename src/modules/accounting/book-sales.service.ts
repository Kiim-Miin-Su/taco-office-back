/** @file-guide
 * 목적: TBO-55 BOC-11F 교재 판매·결제 수수료의 조회·생성·취소 transaction을 소유한다.
 * 책임/재사용: 권한·계산·멱등·version·PAY 보존을 서버 한 곳에서 지키고 화면 추정값을 저장하지 않는다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11F-BOOK-SALES-FEES-2026-10-09.md · migration 1768700000000
 */
import {
  ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { assertMonthOpenForWrite } from '../../lib/month-close';
import { todayKst } from '../../lib/kst';
import { studentTagSql } from '../../lib/student-label';
import type {
  BookSaleCancelDto, BookSaleCreateDto, BookSaleDto, BookSaleFeePolicySnapshotDto,
  BookSaleLedgerDto, BookSaleMethodSummaryDto, BookSalePaymentMethod, BookSaleWriteResultDto,
} from './accounting.dto';

type Row = Record<string, unknown>;
type Action = 'created' | 'canceled';

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nullable = (value: unknown): string | null => value == null ? null : String(value);
const dateOnly = (value: unknown): string => String(value).slice(0, 10);
const iso = (value: unknown): string => new Date(String(value)).toISOString();

const SALE_SELECT = `SELECT bs.*,to_char(bs.sold_on,'YYYY-MM-DD') AS sold_on,
    st.name AS student_name,${studentTagSql('st')} AS student_tag,
    cb.name AS created_by_name,xb.name AS canceled_by_name,
    fp.payment_method AS policy_payment_method,fp.calculation AS policy_calculation,fp.value AS policy_value,
    fp.policy_version,to_char(fp.effective_from,'YYYY-MM-DD') AS policy_effective_from,
    to_char(fp.effective_to,'YYYY-MM-DD') AS policy_effective_to,
    EXISTS(SELECT 1 FROM payment_evidence pe WHERE pe.pay_id=bs.pay_id AND pe.state='issued') AS evidence_issued,
    EXISTS(SELECT 1 FROM month_close mc
      WHERE mc.year_month=to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM') AND mc.reopened_at IS NULL) AS current_month_closed
  FROM book_sale bs
  JOIN stu st ON st.id=bs.student_id
  JOIN staff cb ON cb.id=bs.created_by
  LEFT JOIN staff xb ON xb.id=bs.canceled_by
  JOIN book_sale_fee_policy fp ON fp.id=bs.fee_policy_id`;

@Injectable()
export class BookSalesService {
  constructor(private readonly ds: DataSource) {}

  private policy(row: Row): BookSaleFeePolicySnapshotDto {
    return {
      id: Number(row.fee_policy_id), version: Number(row.policy_version),
      paymentMethod: String(row.policy_payment_method) as BookSalePaymentMethod,
      calculation: String(row.policy_calculation) as BookSaleFeePolicySnapshotDto['calculation'],
      value: Number(row.policy_value), effectiveFrom: String(row.policy_effective_from),
      effectiveTo: nullable(row.policy_effective_to),
    };
  }

  private shape(row: Row, canWrite: boolean): BookSaleDto {
    const status = String(row.status) as BookSaleDto['status'];
    return {
      id: Number(row.id), studentId: Number(row.student_id), studentName: String(row.student_name),
      studentTag: nullable(row.student_tag), bookId: Number(row.book_id), bookCode: String(row.book_code),
      bookTitle: String(row.book_title), bookEdition: nullable(row.book_edition), bookLabel: String(row.book_label),
      soldOn: dateOnly(row.sold_on), quantity: Number(row.quantity), unitPrice: Number(row.unit_price),
      totalAmount: Number(row.total_amount), paymentMethod: String(row.payment_method) as BookSalePaymentMethod,
      feeAmount: Number(row.fee_amount), netAmount: Number(row.net_amount), feePolicy: this.policy(row),
      payId: Number(row.pay_id), correctionPayId: row.correction_pay_id == null ? null : Number(row.correction_pay_id),
      status, version: Number(row.row_version), memo: nullable(row.memo), createdBy: String(row.created_by_name),
      createdAt: iso(row.created_at), canceledBy: nullable(row.canceled_by_name),
      canceledAt: row.canceled_at == null ? null : iso(row.canceled_at), canceledReason: nullable(row.cancel_reason),
      canCancel: canWrite && status === 'completed' && row.evidence_issued !== true && row.current_month_closed !== true,
    };
  }

  private async rows(q: DataSource | EntityManager, id?: number): Promise<Row[]> {
    return q.query(`${SALE_SELECT}${id === undefined ? '' : ' WHERE bs.id=$1'}
      ORDER BY bs.sold_on DESC,bs.id DESC`, id === undefined ? [] : [id]) as Promise<Row[]>;
  }

  private async one(q: DataSource | EntityManager, id: number, canWrite: boolean): Promise<BookSaleDto> {
    const [row] = await this.rows(q, id);
    if (!row) throw new NotFoundException({ code: 'BOOK_SALE_NOT_FOUND', message: '교재 판매를 찾을 수 없습니다' });
    return this.shape(row, canWrite);
  }

  async detail(canWrite: boolean, id: number): Promise<BookSaleDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '교재 판매를 조회할 권한이 없습니다' });
    return this.one(this.ds, id, canWrite);
  }

  async ledger(canWrite: boolean): Promise<BookSaleLedgerDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '교재 판매를 조회할 권한이 없습니다' });
    const rows = await this.rows(this.ds);
    const items = rows.map((row) => this.shape(row, canWrite));
    const active = items.filter((item) => item.status === 'completed');
    const totalAmount = active.reduce((sum, item) => sum + item.totalAmount, 0);
    const methods: BookSaleMethodSummaryDto[] = (['transfer', 'cash'] as const).map((paymentMethod) => {
      const selected = active.filter((item) => item.paymentMethod === paymentMethod);
      const amount = selected.reduce((sum, item) => sum + item.totalAmount, 0);
      return {
        paymentMethod, count: selected.length, amount,
        ratio: totalAmount === 0 ? 0 : Math.round((amount / totalAmount) * 1000) / 10,
        feeAmount: selected.reduce((sum, item) => sum + item.feeAmount, 0),
        netAmount: selected.reduce((sum, item) => sum + item.netAmount, 0),
      };
    });
    return {
      canCreate: canWrite, items, totalCount: active.length, totalAmount,
      totalFeeAmount: methods.reduce((sum, item) => sum + item.feeAmount, 0),
      totalNetAmount: methods.reduce((sum, item) => sum + item.netAmount, 0), methods,
    };
  }

  private async lockPolicy(
    m: EntityManager, method: BookSalePaymentMethod, soldOn: string,
  ): Promise<Row> {
    const [policy] = await m.query(`SELECT id,payment_method,calculation,value,policy_version,
        to_char(effective_from,'YYYY-MM-DD') AS effective_from,
        to_char(effective_to,'YYYY-MM-DD') AS effective_to
      FROM book_sale_fee_policy WHERE payment_method=$1 AND effective_from<=$2::date
        AND (effective_to IS NULL OR effective_to>=$2::date)
      ORDER BY effective_from DESC,policy_version DESC LIMIT 1 FOR SHARE`, [method, soldOn]) as Row[];
    if (!policy) {
      throw new ConflictException({
        code: 'BOOK_SALE_FEE_POLICY_REQUIRED', message: '적용할 결제 수수료 기준이 없습니다 — 기준일을 확인해 주세요',
      });
    }
    return policy;
  }

  private fee(total: number, policy: Row): number {
    const value = Number(policy.value);
    return String(policy.calculation) === 'rate_bps' ? Math.floor((total * value) / 10_000) : value;
  }

  private async lockRequest(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('book-sale-request'),hashtext($1))`, [requestKey]);
  }

  private async replay(
    m: EntityManager, requestKey: string, actorId: number, action: Action, saleId: number | null,
    expectedVersion: number, fingerprint: string, canWrite: boolean,
  ): Promise<BookSaleWriteResultDto | null> {
    const [prior] = await m.query(`SELECT actor_id,action,sale_id,expected_version,payload_sha256,result_version
      FROM book_sale_request WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action
      || (action === 'canceled' && (prior.sale_id == null ? null : Number(prior.sale_id)) !== saleId)
      || Number(prior.expected_version) !== expectedVersion || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'BOOK_SALE_KEY_REUSED', message: '같은 요청 키를 다른 교재 판매 작업에 다시 사용할 수 없습니다',
      });
    }
    const item = await this.one(m, Number(prior.sale_id), canWrite);
    if (item.version !== Number(prior.result_version)) {
      throw new ConflictException({
        code: 'BOOK_SALE_REPLAY_STALE', message: '재시도한 요청 뒤에 판매 상태가 바뀌었습니다 — 최신 목록을 확인해 주세요',
      });
    }
    return { item, replayed: true };
  }

  async create(
    actorId: number, canWrite: boolean, dto: BookSaleCreateDto,
  ): Promise<BookSaleWriteResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '교재 판매를 저장할 권한이 없습니다' });
    if (dto.soldOn > todayKst()) {
      throw new UnprocessableEntityException({ code: 'BOOK_SALE_FUTURE', message: '미래 날짜로 교재 판매를 저장할 수 없습니다' });
    }
    const memo = dto.memo?.trim() || null;
    const total = dto.quantity * dto.unitPrice;
    if (!Number.isSafeInteger(total) || total > 2_000_000_000) {
      throw new UnprocessableEntityException({ code: 'BOOK_SALE_TOTAL_INVALID', message: '판매 합계가 허용 범위를 벗어났습니다' });
    }
    const fingerprint = sha({ ...dto, memo, requestKey: undefined });
    return this.ds.transaction(async (m) => {
      // 권고안 잠금 순서: 월마감 공유 → 수수료 policy → request/current → PAY.
      await assertMonthOpenForWrite(m, dto.soldOn);
      const policy = await this.lockPolicy(m, dto.paymentMethod, dto.soldOn);
      await this.lockRequest(m, dto.requestKey);
      const prior = await this.replay(m, dto.requestKey, actorId, 'created', null, 0, fingerprint, canWrite);
      if (prior) return prior;
      const [[student], [book]] = await Promise.all([
        m.query(`SELECT id,name FROM stu WHERE id=$1`, [dto.studentId]) as Promise<Row[]>,
        m.query(`SELECT l.id,l.code,l.title,cur.edition FROM lib l LEFT JOIN LATERAL (
          SELECT v.edition FROM vers v WHERE v.lib_id=l.id AND (v.from_date IS NULL OR v.from_date<=$2::date)
          ORDER BY v.from_date DESC NULLS LAST,v.activated_at DESC,v.id DESC LIMIT 1
        ) cur ON true WHERE l.id=$1`, [dto.bookId, dto.soldOn]) as Promise<Row[]>,
      ]);
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      if (!book) throw new NotFoundException({ code: 'BOOK_NOT_FOUND', message: '교재를 찾을 수 없습니다' });
      const feeAmount = this.fee(total, policy);
      if (!Number.isSafeInteger(feeAmount) || feeAmount < 0 || feeAmount > total) {
        throw new ConflictException({ code: 'BOOK_SALE_FEE_INVALID', message: '적용된 수수료 기준을 확인해 주세요' });
      }
      const edition = nullable(book.edition);
      const label = [book.code, book.title, edition].filter(Boolean).join(' · ');
      const [pay] = await m.query(`INSERT INTO pay(
          inv_id,student_id,amount,paid_on,method,reason,entered_by,entered_at,confirmed_by,confirmed_at,request_key)
        VALUES(NULL,$1,$2,$3::date,$4,$5,$6,now(),$6,now(),$7) RETURNING id`, [
        dto.studentId, total, dto.soldOn, dto.paymentMethod, `교재비 · ${label}`, actorId, dto.requestKey,
      ]) as Row[];
      const [sale] = await m.query(`INSERT INTO book_sale(
          student_id,book_id,book_code,book_title,book_edition,book_label,sold_on,quantity,unit_price,total_amount,
          payment_method,fee_policy_id,fee_policy_version,fee_amount,net_amount,pay_id,status,row_version,memo,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,'completed',1,$17,$18)
        RETURNING id`, [
        dto.studentId, dto.bookId, book.code, book.title, edition, label, dto.soldOn, dto.quantity, dto.unitPrice,
        total, dto.paymentMethod, policy.id, policy.policy_version, feeAmount, total - feeAmount, pay.id, memo, actorId,
      ]) as Row[];
      await m.query(`INSERT INTO book_sale_request(
          request_key,actor_id,action,sale_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,'created',$3,0,$4,1)`, [dto.requestKey, actorId, sale.id, fingerprint]);
      await m.query(`INSERT INTO book_sale_event(
          sale_id,action,from_status,to_status,actor_id,request_key,result_version,total_amount,fee_amount,net_amount,
          pay_id,correction_pay_id,reason)
        VALUES($1,'created',NULL,'completed',$2,$3,1,$4,$5,$6,$7,NULL,NULL)`, [
        sale.id, actorId, dto.requestKey, total, feeAmount, total - feeAmount, pay.id,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,after)
        VALUES($1,'BOOK_SALE',$2,'create',$3::jsonb)`, [
        actorId, sale.id, JSON.stringify({ studentId: dto.studentId, bookId: dto.bookId, soldOn: dto.soldOn,
          quantity: dto.quantity, unitPrice: dto.unitPrice, totalAmount: total, paymentMethod: dto.paymentMethod,
          feePolicyId: Number(policy.id), feePolicyVersion: Number(policy.policy_version), feeAmount,
          netAmount: total - feeAmount, payId: Number(pay.id), requestKey: dto.requestKey }),
      ]);
      return { item: await this.one(m, Number(sale.id), canWrite), replayed: false };
    });
  }

  private stale(expectedVersion: number, actualVersion: number): never {
    throw new ConflictException({
      code: 'BOOK_SALE_STALE', message: '교재 판매 상태가 다른 작업에서 바뀌었습니다 — 다시 불러와 주세요',
      details: { expectedVersion, actualVersion },
    });
  }

  async cancel(
    actorId: number, canWrite: boolean, saleId: number, dto: BookSaleCancelDto,
  ): Promise<BookSaleWriteResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '교재 판매를 취소할 권한이 없습니다' });
    const reason = dto.reason.trim();
    const fingerprint = sha({ saleId, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await assertMonthOpenForWrite(m, todayKst());
      const [hint] = await m.query(`SELECT fee_policy_id,payment_method,sold_on FROM book_sale WHERE id=$1`, [saleId]) as Row[];
      if (!hint) throw new NotFoundException({ code: 'BOOK_SALE_NOT_FOUND', message: '교재 판매를 찾을 수 없습니다' });
      await m.query(`SELECT id FROM book_sale_fee_policy WHERE id=$1 FOR SHARE`, [hint.fee_policy_id]);
      await this.lockRequest(m, dto.requestKey);
      const prior = await this.replay(
        m, dto.requestKey, actorId, 'canceled', saleId, dto.expectedVersion, fingerprint, canWrite,
      );
      if (prior) return prior;
      const [current] = await m.query(`SELECT * FROM book_sale WHERE id=$1 FOR UPDATE`, [saleId]) as Row[];
      const actualVersion = Number(current.row_version);
      if (dto.expectedVersion !== actualVersion) this.stale(dto.expectedVersion, actualVersion);
      if (String(current.status) !== 'completed') {
        throw new ConflictException({ code: 'BOOK_SALE_NOT_CANCELABLE', message: '이미 취소된 교재 판매입니다' });
      }
      const [evidence] = await m.query(`SELECT id FROM payment_evidence WHERE pay_id=$1 AND state='issued'`, [current.pay_id]) as Row[];
      if (evidence) {
        throw new ConflictException({
          code: 'BOOK_SALE_EVIDENCE_ISSUED', message: '발행한 입금 증빙을 먼저 취소해 주세요',
        });
      }
      const [correction] = await m.query(`INSERT INTO pay(
          inv_id,student_id,amount,paid_on,method,reason,entered_by,entered_at,confirmed_by,confirmed_at,request_key)
        VALUES(NULL,$1,$2,$3::date,$4,$5,$6,now(),$6,now(),$7) RETURNING id`, [
        current.student_id, -Number(current.total_amount), todayKst(), current.payment_method,
        `교재 판매 취소 #${saleId} · ${reason}`, actorId, dto.requestKey,
      ]) as Row[];
      const nextVersion = actualVersion + 1;
      await m.query(`UPDATE book_sale SET status='canceled',row_version=$2,correction_pay_id=$3,
        canceled_by=$4,canceled_at=now(),cancel_reason=$5 WHERE id=$1`, [
        saleId, nextVersion, correction.id, actorId, reason,
      ]);
      await m.query(`INSERT INTO book_sale_request(
          request_key,actor_id,action,sale_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,'canceled',$3,$4,$5,$6)`, [
        dto.requestKey, actorId, saleId, dto.expectedVersion, fingerprint, nextVersion,
      ]);
      await m.query(`INSERT INTO book_sale_event(
          sale_id,action,from_status,to_status,actor_id,request_key,result_version,total_amount,fee_amount,net_amount,
          pay_id,correction_pay_id,reason)
        VALUES($1,'canceled','completed','canceled',$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        saleId, actorId, dto.requestKey, nextVersion, current.total_amount, current.fee_amount, current.net_amount,
        current.pay_id, correction.id, reason,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'BOOK_SALE',$2,'cancel',$3::jsonb,$4::jsonb)`, [
        actorId, saleId,
        JSON.stringify({ status: 'completed', version: actualVersion, payId: Number(current.pay_id) }),
        JSON.stringify({ status: 'canceled', version: nextVersion, correctionPayId: Number(correction.id),
          reason, requestKey: dto.requestKey }),
      ]);
      return { item: await this.one(m, saleId, canWrite), replayed: false };
    });
  }
}
