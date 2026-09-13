/** @file-guide
 * 목적: consulting.service.ts — ConsultingService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { todayKst } from '../../lib/kst';
import { csCan, csCanAmount, csCanFull, type ConsShare, type ConsViewer } from '../../lib/rules';
import { INV_TYPE_LABEL } from '../accounting/accounting.dto';
import type {
  ConsAccountingDto, ConsAccountRowDto, ConsItemDto, ConsItemToggleDto,
  ConsPaymentCreateDto, ConsPaymentDto, ConsultingListDto, ConsultingSessionDto,
} from './consulting.dto';
import {
  CONTRACT_STEP_MAX, consultingRecordIssue, consultingSessionIssue, consultingStageLabel,
  type ConsultingRecord,
} from './consulting.rules';

type R = Record<string, unknown>;

function assertRecord(record: { stage: unknown; contractStep: unknown; sessions: unknown }): asserts record is ConsultingRecord {
  if (consultingRecordIssue(record)) throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
}

/**
 * 컨설팅 — 권한이 **두 층**이다 (DEV-SPEC §4.4).
 *
 *   ① 역할 파생 (D-R39)      — 탭을 열 수 있는가 · 금액을 볼 수 있는가
 *   ② 건별 공개 범위 (share) — 이 건이 목록에 보이는가 · 내용이 열리는가
 *
 * 둘은 독립이라 **둘 다** 통과해야 보인다. 판정은 rules.ts 의 csCan/csCanFull/csCanAmount
 * 한 곳에서만 하고, 여기서는 그 결과로 행을 거를 뿐이다.
 */
@Injectable()
export class ConsultingService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  async all(viewerId: number, canMoney: boolean, canHide: boolean): Promise<ConsultingListDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              to_char(c.end_on,'YYYY-MM-DD')      AS end_on,
              to_char(c.created_at,'YYYY-MM-DD')  AS created_at,
              o.name AS owner_name,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              COALESCE(
                (SELECT array_agg(s.name ORDER BY s.name)
                   FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                  WHERE cs.cons_id = c.id), '{}') AS student_names
         FROM cons c LEFT JOIN staff o ON o.id = c.owner_id
        ORDER BY c.created_at DESC, c.id`,
      [viewerId],
    );

    // 권한 판정은 csCan* 한 곳만 사용한다. 숨겨진 건의 오염/회차도 응답에 영향을 주지 않는다.
    const visible = rows.flatMap((r) => {
      const share = String(r.share) as ConsShare;
      const viewer: ConsViewer = {
        isOwner: r.owner_id !== null && Number(r.owner_id) === viewerId,
        isPicked: r.is_picked === true, canHide, canMoney,
      };
      return csCan(share, viewer) ? [{ r, share, full: csCanFull(share, viewer), money: csCanAmount(share, viewer) }] : [];
    });
    const fullIds = visible.filter(({ full }) => full).map(({ r }) => Number(r.id));
    const logs = fullIds.length ? await this.q(
      `SELECT id, cons_id, seq, to_char(on_date,'YYYY-MM-DD') AS on_date, who, what, why, how, ser_id
         FROM cons_sess WHERE cons_id = ANY($1::bigint[]) ORDER BY cons_id, seq`,
      [fullIds],
    ) : [];
    const itemRows = fullIds.length ? await this.q(
      `SELECT i.id, i.cons_id, i.seq, i.label, i.required, i.done, i.source,
              to_char(i.done_at,'YYYY-MM-DD') AS done_on, s.name AS done_by_name
         FROM cons_item i LEFT JOIN staff s ON s.id = i.done_by
        WHERE i.cons_id = ANY($1::bigint[]) ORDER BY i.cons_id, i.seq`,
      [fullIds],
    ) : [];
    const itemsByCons = new Map<number, ConsItemDto[]>();
    for (const r of itemRows) {
      const k = Number(r.cons_id);
      if (!itemsByCons.has(k)) itemsByCons.set(k, []);
      itemsByCons.get(k)!.push({
        id: Number(r.id), seq: Number(r.seq), label: String(r.label),
        required: r.required === true, done: r.done === true, source: String(r.source),
        doneBy: (r.done_by_name as string) ?? null, doneOn: (r.done_on as string) ?? null,
      });
    }

    const byCons = new Map<number, ConsultingSessionDto[]>();
    for (const r of logs) {
      const k = Number(r.cons_id);
      if (!byCons.has(k)) byCons.set(k, []);
      byCons.get(k)!.push({
        id: Number(r.id), seq: Number(r.seq), onDate: (r.on_date as string) ?? null,
        who: (r.who as string) ?? null, what: (r.what as string) ?? null,
        why: (r.why as string) ?? null, how: (r.how as string) ?? null,
        serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
      });
    }

    for (const sessions of byCons.values()) {
      if (consultingSessionIssue(sessions.map(({ seq }) => seq))) {
        throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
      }
    }

    const items = visible.map(({ r, share, full, money }) => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: r.sessions };
      assertRecord(record);

      return {
        id: Number(r.id),
        consType: String(r.cons_type),
        stage: record.stage,
        share,
        contractStep: record.contractStep,
        studentNames: (r.student_names as string[]) ?? [],
        ownerName: (r.owner_name as string) ?? null,
        sessions: record.sessions,
        endOn: (r.end_on as string) ?? null,
        createdAt: String(r.created_at),
        amount: money && r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
        canOpen: full,
        // 내용이 안 열리면 회차 기록도 내려보내지 않는다 — 화면에서 감추는 건 감춘 게 아니다
        sessionsLog: full ? (byCons.get(Number(r.id)) ?? []) : [],
        items: full ? (itemsByCons.get(Number(r.id)) ?? []) : [],
      };
    });

    return { items, canSeeAmounts: canMoney };
  }

  /**
   * §31 항목 체크/해제 — 47D-B 의 유일한 쓰기. 공개 범위(csCanFull)와 종료 잠금은 서버가 판정한다.
   * 보이지 않는 건은 404(존재 누출 금지), 내용 잠김은 403, 종료 건은 409 ITEM_LOCKED.
   */
  async toggleItem(viewerId: number, canHide: boolean, consId: number, itemId: number, dto: ConsItemToggleDto): Promise<ConsItemDto> {
    const [c] = await this.q(
      `SELECT c.id, c.stage, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $2) AS is_picked
         FROM cons c WHERE c.id = $1`, [consId, viewerId]);
    if (!c) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    const share = String(c.share) as ConsShare;
    const viewer: ConsViewer = {
      isOwner: c.owner_id !== null && Number(c.owner_id) === viewerId,
      isPicked: c.is_picked === true, canHide, canMoney: false,
    };
    if (!csCan(share, viewer)) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    if (!csCanFull(share, viewer)) throw new ForbiddenException('이 건의 내용은 공개 범위 밖입니다');
    if (String(c.stage) === 'done') {
      throw new ConflictException({ code: 'ITEM_LOCKED', message: '종료된 컨설팅의 항목은 바꿀 수 없습니다' });
    }
    const [exists] = await this.q(`SELECT id FROM cons_item WHERE id = $1 AND cons_id = $2`, [itemId, consId]);
    if (!exists) throw new NotFoundException('항목을 찾을 수 없습니다');
    // UPDATE 의 RETURNING 은 드라이버가 [rows, count] 로 감싼다 — 갱신과 조회를 분리해 모양 의존을 없앤다
    await this.q(
      dto.done
        ? `UPDATE cons_item SET done = true, done_by = $3, done_at = now() WHERE id = $1 AND cons_id = $2`
        : `UPDATE cons_item SET done = false, done_by = NULL, done_at = NULL WHERE id = $1 AND cons_id = $2`,
      dto.done ? [itemId, consId, viewerId] : [itemId, consId],
    );
    const [r] = await this.q(
      `SELECT i.id, i.seq, i.label, i.required, i.done, i.source,
              to_char(i.done_at,'YYYY-MM-DD') AS done_on, s.name AS done_by_name
         FROM cons_item i LEFT JOIN staff s ON s.id = i.done_by
        WHERE i.id = $1`, [itemId]);
    return {
      id: Number(r.id), seq: Number(r.seq), label: String(r.label),
      required: r.required === true, done: r.done === true, source: String(r.source),
      doneBy: (r.done_by_name as string) ?? null, doneOn: (r.done_on as string) ?? null,
    };
  }

  /* ══ §28 컨설팅 회계 (C58) ═════════════════════════════════════════════
   * 원문 슬라이드 28 — 데이터 `CONS.amt, CONS.pay[]` · 동작 「납부 넣기 · 청구서로 전환」
   * 규칙 「수납만 공개(vis='pay')여도 이 화면의 금액은 보입니다」 · 연동 「INV 에 csid 로 연결」
   *
   * 그 규칙은 새 판정이 아니라 **이미 있는 csCanAmount 그대로다** — csCan 이 money_only 를
   * 통과시키므로 `csCan && canMoney` 면 수납만 공개 건의 금액도 보인다. 여기서 다시 세지 않는다.
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 이 뷰어가 이 건을 어떻게 볼 수 있는가 — 목록·회계·쓰기가 같은 한 곳을 쓴다.
   * 보이지 않으면 404 로 끝낸다(존재 누출 금지 — toggleItem 과 같은 규약).
   */
  private async gate(
    viewerId: number, canHide: boolean, canMoney: boolean, consId: number,
  ): Promise<{ row: R; share: ConsShare; viewer: ConsViewer }> {
    const [c] = await this.q(
      `SELECT c.id, c.stage, c.contract_step, c.amount, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $2) AS is_picked
         FROM cons c WHERE c.id = $1`, [consId, viewerId]);
    if (!c) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    const share = String(c.share) as ConsShare;
    const viewer: ConsViewer = {
      isOwner: c.owner_id !== null && Number(c.owner_id) === viewerId,
      isPicked: c.is_picked === true, canHide, canMoney,
    };
    if (!csCan(share, viewer)) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    return { row: c, share, viewer };
  }

  /**
   * §28 회계 표 — 계약 하나가 한 줄, 머리 세 칸은 그 줄들의 합이다.
   *
   * **남은 돈은 서버가 뺀다** (D-R37). 화면이 계약 − 받음을 다시 하면 반올림도 없는 뺄셈이
   * 두 곳에 생기고, 금액이 가려진 줄을 화면이 0 으로 세는 순간 머리 칸과 갈린다.
   * 합계도 같은 이유로 서버가 낸다 — 화면은 받은 숫자를 그리기만 한다.
   */
  async accounting(viewerId: number, canMoney: boolean, canHide: boolean): Promise<ConsAccountingDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              COALESCE((SELECT array_agg(s.name ORDER BY s.name)
                          FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                         WHERE cs.cons_id = c.id), '{}') AS student_names,
              COALESCE((SELECT sum(p.amount) FROM cons_pay p WHERE p.cons_id = c.id), 0) AS paid,
              (SELECT i.id FROM inv i WHERE i.cs_id = c.id AND i.state <> 'void') AS inv_id
         FROM cons c
        ORDER BY c.created_at DESC, c.id`,
      [viewerId],
    );

    const visible = rows.flatMap((r) => {
      const share = String(r.share) as ConsShare;
      const viewer: ConsViewer = {
        isOwner: r.owner_id !== null && Number(r.owner_id) === viewerId,
        isPicked: r.is_picked === true, canHide, canMoney,
      };
      return csCan(share, viewer) ? [{ r, money: csCanAmount(share, viewer) }] : [];
    });

    const ids = visible.map(({ r }) => Number(r.id));
    const payRows = ids.length ? await this.q(
      `SELECT p.id, p.cons_id, p.amount, to_char(p.paid_on,'YYYY-MM-DD') AS paid_on, p.memo, s.name AS by_name
         FROM cons_pay p LEFT JOIN staff s ON s.id = p.by_id
        WHERE p.cons_id = ANY($1::bigint[])
        ORDER BY p.paid_on, p.id`,
      [ids],
    ) : [];
    const paysByCons = new Map<number, ConsPaymentDto[]>();
    for (const p of payRows) {
      const k = Number(p.cons_id);
      if (!paysByCons.has(k)) paysByCons.set(k, []);
      paysByCons.get(k)!.push({
        id: Number(p.id), amount: Number(p.amount), paidOn: String(p.paid_on),
        memo: (p.memo as string) ?? null, byName: (p.by_name as string) ?? null,
      });
    }

    let totalAmount = 0, totalPaid = 0, totalDue = 0;
    const items: ConsAccountRowDto[] = visible.map(({ r, money }) => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: null };
      assertRecord(record);
      const amount = r.amount === null || r.amount === undefined ? null : Number(r.amount);
      const paid = Number(r.paid);
      const due = amount === null ? null : amount - paid;
      if (money && amount !== null) { totalAmount += amount; totalPaid += paid; totalDue += due!; }
      const invId = r.inv_id === null || r.inv_id === undefined ? null : Number(r.inv_id);
      const stage = record.stage;
      return {
        id: Number(r.id),
        // 학생 이름은 이미 목록이 쓰는 배열 그대로다 — 여럿이면 원문 표의 한 칸에 쉼표로 든다
        studentName: ((r.student_names as string[]) ?? []).join(', '),
        consType: String(r.cons_type),
        stage,
        stageLabel: consultingStageLabel(stage),
        amount: money ? amount : null,
        paid: money ? paid : null,
        due: money ? due : null,
        // 금액이 가려지면 납부 기록도 내려보내지 않는다 — 줄을 세면 금액이 드러난다
        payments: money ? (paysByCons.get(Number(r.id)) ?? []) : [],
        invId,
        canInvoice: money && invId === null && this.invoiceable(record.contractStep, due),
      };
    });

    return {
      items,
      totalAmount: canMoney ? totalAmount : null,
      totalPaid: canMoney ? totalPaid : null,
      totalDue: canMoney ? totalDue : null,
      canSeeAmounts: canMoney,
    };
  }

  /**
   * 청구서로 전환할 수 있는가 — 원문 슬라이드 30 「**수납 시** 청구서(INV) 생성 **가능**」.
   * 수납은 계약 5단계다(CONTRACT_STEP_MAX). 4단계까지는 아직 받을 돈이 확정되지 않았다.
   * 남은 돈이 0 이하면 전환할 것이 없다 — 0 원 청구서는 조용히 틀린 청구서다(§53 과 같은 판단).
   */
  private invoiceable(contractStep: number | null, due: number | null): boolean {
    return contractStep === CONTRACT_STEP_MAX && due !== null && due > 0;
  }

  /**
   * 납부 넣기 — 원문 §28 동작 ①. `cons_pay` 원장에 한 줄 더한다.
   *
   * `pay` 표를 빌려 쓰지 않는다 — `pay` 는 `inv_id` 에 매달려 있는데 컨설팅 수납은
   * 청구서 없이도 들어온다(슬라이드 30 「수납 시 청구서 생성 **가능**」 — 가능이지 필수가 아니다).
   * 받은 합은 저장하지 않는다. 합계는 읽을 때 원장을 더해서 만든다 (D-R37).
   */
  async addPayment(
    viewerId: number, canMoney: boolean, canHide: boolean, consId: number, dto: ConsPaymentCreateDto,
  ): Promise<ConsAccountRowDto> {
    const { row, share, viewer } = await this.gate(viewerId, canHide, canMoney, consId);
    if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');
    if (String(row.stage) === 'done') {
      throw new ConflictException({ code: 'CONS_PAY_LOCKED', message: '종료된 컨설팅에는 납부를 더할 수 없습니다' });
    }
    if (dto.paidOn > todayKst()) throw new BadRequestException('납부일이 오늘보다 뒤일 수 없습니다');

    await this.q(
      `INSERT INTO cons_pay (cons_id, amount, paid_on, memo, by_id) VALUES ($1, $2, $3::date, $4, $5)`,
      [consId, dto.amount, dto.paidOn, dto.memo?.trim() || null, viewerId],
    );
    return this.oneRow(viewerId, canMoney, canHide, consId);
  }

  /**
   * 청구서로 전환 — 원문 §28 동작 ② · 연동 「INV 에 csid 로 연결」.
   *
   * **남은 돈으로 낸다.** 계약 금액 전액으로 내면 이미 `cons_pay` 에 들어온 돈이 청구서에도
   * 한 번 더 얹혀 §53 미수금이 부풀어 오른다 — 같은 돈을 두 원장이 세는 순간이다 (D-R37).
   * 전환 뒤에도 납부 기록은 `cons_pay` 에 그대로 남는다. `inv.cs_id` 는 연결이지 소유가 아니다.
   *
   * 학생이 둘 이상인 건은 전환하지 않는다 — `inv.student_id` 는 한 명이고, 누구 앞으로 낼지는
   * 원문에 없다. 고르는 건 추정이라 409 로 돌려보내고 사람이 정하게 한다 (N-33).
   */
  async toInvoice(viewerId: number, canMoney: boolean, canHide: boolean, consId: number): Promise<ConsAccountRowDto> {
    const { share, viewer } = await this.gate(viewerId, canHide, canMoney, consId);
    if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');

    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      // 같은 건을 두 번 눌러도 청구서는 하나다 — 잠그고 다시 센다 (inv_cs_id_live_uniq 가 최후 방어)
      const [c] = (await m.query(
        `SELECT id, amount, contract_step, stage FROM cons WHERE id = $1 FOR UPDATE`, [consId],
      )) as Array<R>;
      const [{ live }] = (await m.query(
        `SELECT count(*)::int AS live FROM inv WHERE cs_id = $1 AND state <> 'void'`, [consId],
      )) as Array<{ live: number }>;
      if (live > 0) {
        throw new ConflictException({ code: 'CONS_INV_EXISTS', message: '이미 이 컨설팅의 청구서가 있습니다' });
      }
      const [{ paid }] = (await m.query(
        `SELECT COALESCE(sum(amount), 0)::int AS paid FROM cons_pay WHERE cons_id = $1`, [consId],
      )) as Array<{ paid: number }>;
      const amount = c.amount === null || c.amount === undefined ? null : Number(c.amount);
      const step = c.contract_step === null || c.contract_step === undefined ? null : Number(c.contract_step);
      const due = amount === null ? null : amount - paid;
      if (step !== CONTRACT_STEP_MAX) {
        throw new ConflictException({
          code: 'CONS_INV_NOT_PAID_STEP',
          message: '계약 5단계(수납)부터 청구서로 전환합니다 — 서명본을 먼저 올리세요',
        });
      }
      if (due === null || due <= 0) {
        throw new ConflictException({
          code: 'CONS_INV_NOTHING_DUE',
          message: '남은 돈이 없습니다 — 낼 청구서가 없습니다',
        });
      }
      const students = (await m.query(
        `SELECT student_id FROM cons_stu WHERE cons_id = $1 ORDER BY student_id`, [consId],
      )) as Array<{ student_id: string }>;
      if (students.length !== 1) {
        throw new ConflictException({
          code: 'CONS_INV_STUDENT_AMBIGUOUS',
          message: students.length === 0
            ? '학생이 연결되지 않은 컨설팅입니다 — 청구서를 누구 앞으로 낼지 정할 수 없습니다'
            : '학생이 둘 이상인 컨설팅입니다 — 청구서는 학생 한 명 앞으로만 냅니다',
        });
      }
      const today = todayKst();
      const [ym, mm] = today.split('-');
      await m.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, issued_on, created_by, cs_id)
         VALUES ($1, $2, 'consulting', $3, $4, 'draft', $5::date, $6, $7)`,
        [
          Number(students[0].student_id), `${ym}-${mm}`,
          `${ym}년 ${Number(mm)}월 ${INV_TYPE_LABEL.consulting}`,
          due, today, viewerId, consId,
        ],
      );
    });
    return this.oneRow(viewerId, canMoney, canHide, consId);
  }

  /** 쓰기 뒤 그 줄 하나를 다시 읽는다 — 화면이 고쳐 그릴 숫자를 화면이 만들지 않게. */
  private async oneRow(viewerId: number, canMoney: boolean, canHide: boolean, consId: number): Promise<ConsAccountRowDto> {
    const { items } = await this.accounting(viewerId, canMoney, canHide);
    const hit = items.find((x) => x.id === consId);
    if (!hit) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    return hit;
  }
}
