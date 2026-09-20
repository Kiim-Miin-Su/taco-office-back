/** @file-guide
 * 목적: consulting.service.ts — ConsultingService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Lead } from '../../entities';
import { hasPerm, isRole } from '../../common/perm';
import { overdueDays as daysSince, todayKst } from '../../lib/kst';
import { csCan, csCanAmount, csCanFull, type ConsShare, type ConsViewer } from '../../lib/rules';
import { INV_TYPE_LABEL } from '../accounting/accounting.dto';
import { fileUrlOf, storeFile } from '../files/files.service';
import type {
  ConsAccountingDto, ConsAccountRowDto, ConsItemDto, ConsItemToggleDto,
  ConsPaymentCreateDto, ConsPaymentDto, ConsStudentCaseDto, ConsStudentDto, ConsStudentsDto,
  ConsultingCreateDto, ConsultingDetailDto,
  ConsultingFeedbackCreateDto, ConsultingFeedbackDto, ConsultingFileDto, ConsultingListDto,
  ConsultingFileCreateDto, ConsultingSessionDto, ConsultingShareUpdateDto,
} from './consulting.dto';
import {
  CONSULTING_FILE_MAX, CONSULTING_STAGES, CONSULTING_STAGE_LABEL, CONSULTING_STAGE_SUB,
  CONSULTING_TYPE_LABEL, CONTRACT_STEP_MAX, INTERNATIONAL_SCHOOL_ITEMS,
  consShareLabel, consultingCloseIssue, consultingContractStepLabel, consultingRecordIssue, consultingRequesterLabel,
  consultingSessionAddIssue, consultingSessionDone, consultingSessionIssue, consultingStageLabel,
  type ConsultingFileRole, type ConsultingType,
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

  private viewer(row: R, viewerId: number, canHide: boolean, canMoney: boolean): ConsViewer {
    return {
      isOwner: row.owner_id !== null && Number(row.owner_id) === viewerId,
      isPicked: row.is_picked === true,
      canHide,
      canMoney,
    };
  }

  private assertPicked(share: ConsShare, ids: readonly number[] | undefined): number[] {
    const picked = ids ?? [];
    if (share === 'picked' && picked.length === 0) {
      throw new BadRequestException({ code: 'CONS_PICK_REQUIRED', message: '지정 공개는 지정 직원을 한 명 이상 골라야 합니다' });
    }
    if (share !== 'picked' && picked.length > 0) {
      throw new BadRequestException({ code: 'CONS_PICK_FORBIDDEN', message: '지정 공개가 아닐 때 지정 직원은 비워야 합니다' });
    }
    if (new Set(picked).size !== picked.length) {
      throw new BadRequestException({ code: 'CONS_PICK_DUPLICATE', message: '지정 직원이 중복되었습니다' });
    }
    return [...picked];
  }

  /**
   * **비공개 「지정」은 대표만** — §76 원문과 `perm.ts` 의 `canHide` 주석이 「비공개 **지정**·열람은 대표 전용」
   * 이라 적는데 코드는 **열람만** 막고 있었다(S4). 그래서 자기가 담당인 건이면 매니저도 숨길 수 있었고,
   * 숨긴 뒤에는 `csCan('private')` 이 담당을 통과시켜 **본인에게는 그대로 보였다** — 대표에게만 보이도록
   * 정한 상태를 대표가 아닌 사람이 만들 수 있었다는 뜻이다.
   *
   * 막는 것은 **지정 하나**다(D-R44) — 이미 비공개인 건을 여는 판정(`csCan`·`csCanFull`)은 그대로다.
   */
  private assertCanSetPrivate(share: ConsShare, canHide: boolean): void {
    if (share === 'private' && !canHide) {
      throw new ForbiddenException({
        code: 'CONS_PRIVATE_FORBIDDEN',
        message: '비공개로 지정하는 것은 대표만 할 수 있습니다 — §76',
      });
    }
  }

  /** 쓰기 성공 뒤 호출자 자신이 방금 만든/바꾼 건에서 잠기는 실패를 커밋 전에 막는다. */
  private assertNoSelfLockout(
    share: ConsShare, ownerId: number | null, picked: readonly number[], viewerId: number, canHide: boolean,
  ): void {
    const remainsOpen = csCanFull(share, {
      isOwner: ownerId === viewerId,
      isPicked: picked.includes(viewerId),
      canHide,
      canMoney: false,
    });
    if (!remainsOpen) {
      throw new ForbiddenException({
        code: 'CONS_SELF_LOCKOUT',
        message: '저장 뒤에도 이 계약을 열 수 있도록 본인을 담당자 또는 지정 직원에 포함해야 합니다',
      });
    }
  }

  /** owner/picked는 활성 백오피스 사용자만 허용한다. 역할 문자열 비교는 공용 권한 함수에 맡긴다. */
  private async assertActiveAdminStaff(m: EntityManager, ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = (await m.query(
      `SELECT id,role,can_money,can_wage,can_approve,can_hide,can_gpa_pack
         FROM staff WHERE id=ANY($1::bigint[]) AND active`, [ids],
    )) as Array<R>;
    const valid = rows.filter((r) => isRole(r.role) && hasPerm(r.role, 'canAdminPage', {
      canMoney: r.can_money as boolean | null,
      canWage: r.can_wage as boolean | null,
      canApprove: r.can_approve as boolean | null,
      canHide: r.can_hide as boolean | null,
      canGpaPack: r.can_gpa_pack as boolean | null,
    }) && hasPerm(r.role, 'canCrudAll')).length;
    if (valid !== new Set(ids).size) {
      throw new BadRequestException({ code: 'CONS_STAFF_INVALID', message: '담당/지정 직원은 활성 백오피스 사용자여야 합니다' });
    }
  }

  private async lockVisible(
    m: EntityManager, viewerId: number, canHide: boolean, canMoney: boolean, consId: number,
  ): Promise<{ row: R; share: ConsShare; viewer: ConsViewer }> {
    const [row] = (await m.query(
      `SELECT c.*,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id=c.id AND p.staff_id=$2) AS is_picked
         FROM cons c WHERE c.id=$1 AND c.deleted_at IS NULL FOR UPDATE OF c`, [consId, viewerId],
    )) as R[];
    if (!row) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    const share = String(row.share) as ConsShare;
    const viewer = this.viewer(row, viewerId, canHide, canMoney);
    if (!csCan(share, viewer)) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    return { row, share, viewer };
  }

  /** 내용까지 열리는 건을 FOR UPDATE 로 잡는다 — 회차·종료 쓰기(C95 `ConsultingSessionService`)도 같은 문을 지난다 */
  async lockFull(m: EntityManager, viewerId: number, canHide: boolean, consId: number): Promise<R> {
    const { row, share, viewer } = await this.lockVisible(m, viewerId, canHide, false, consId);
    if (!csCanFull(share, viewer)) throw new ForbiddenException('이 건의 내용은 공개 범위 밖입니다');
    return row;
  }

  async create(viewerId: number, canMoney: boolean, canHide: boolean, dto: ConsultingCreateDto): Promise<ConsultingDetailDto> {
    const picked = this.assertPicked(dto.share, dto.pickedStaffIds);
    this.assertCanSetPrivate(dto.share, canHide);
    this.assertNoSelfLockout(dto.share, dto.ownerId, picked, viewerId, canHide);
    if (dto.startOn > dto.endOn) {
      throw new BadRequestException({ code: 'CONS_DATE_ORDER', message: '종료일은 시작일보다 빠를 수 없습니다' });
    }
    const id = await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      await this.assertActiveAdminStaff(m, [dto.ownerId, ...picked]);
      const [{ count }] = (await m.query(
        `SELECT count(*)::int AS count FROM stu WHERE id=ANY($1::bigint[])`, [dto.studentIds],
      )) as Array<{ count: number }>;
      if (count !== dto.studentIds.length) {
        throw new BadRequestException({ code: 'CONS_STUDENT_INVALID', message: '존재하지 않는 학생이 포함되었습니다' });
      }
      const [created] = (await m.query(
        `INSERT INTO cons (cons_type,stage,contract_step,amount,sessions,start_on,end_on,requester,owner_id,share)
         VALUES ($1,'contract',1,$2,$3,$4::date,$5::date,$6,$7,$8)
         RETURNING id`,
        [dto.consType, dto.amount, dto.sessions, dto.startOn, dto.endOn, dto.requester, dto.ownerId, dto.share],
      )) as Array<{ id: string }>;
      const consId = Number(created.id);
      await m.query(`INSERT INTO cons_stu (cons_id,student_id) SELECT $1,unnest($2::bigint[])`, [consId, dto.studentIds]);
      if (picked.length) await m.query(`INSERT INTO cons_pick (cons_id,staff_id) SELECT $1,unnest($2::bigint[])`, [consId, picked]);
      if (dto.consType === 'admissions') {
        await m.query(
          `INSERT INTO cons_item (cons_id,seq,label,required,done,source)
           SELECT $1, ordinality::smallint, label, true, false, 'template'
             FROM unnest($2::text[]) WITH ORDINALITY AS x(label,ordinality)`,
          [consId, [...INTERNATIONAL_SCHOOL_ITEMS]],
        );
      }
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'created',$2)`, [consId, viewerId]);
      return consId;
    });
    return this.detail(viewerId, canMoney, canHide, id);
  }

  async detail(viewerId: number, canMoney: boolean, canHide: boolean, consId: number): Promise<ConsultingDetailDto> {
    return this.anyRepo.manager.transaction(async (m) => this.detailLocked(m, viewerId, canMoney, canHide, consId));
  }

  /**
   * 상세 응답은 공개 범위 판정부터 모든 자식 원장 조회까지 같은 트랜잭션에서 만든다.
   * `FOR SHARE`로 CONS 한 줄을 잡아 두어 share 변경/보관이 중간에 끼어 권한이 바뀐
   * 응답이나 `undefined` 접근 500을 만들지 않게 한다. 읽기끼리는 서로 막지 않는다.
   */
  private async detailLocked(
    m: EntityManager, viewerId: number, canMoney: boolean, canHide: boolean, consId: number,
  ): Promise<ConsultingDetailDto> {
    const q = <T = R>(sql: string, p: unknown[] = []): Promise<T[]> => m.query(sql, p) as Promise<T[]>;
    const { share, viewer } = await this.gate(m, viewerId, canHide, canMoney, consId);
    if (!csCanFull(share, viewer)) throw new ForbiddenException('이 건의 내용은 공개 범위 밖입니다');
    const [detail] = await q(
      `SELECT c.*,to_char(c.start_on,'YYYY-MM-DD') AS start_on_text,to_char(c.end_on,'YYYY-MM-DD') AS end_on_text,
              to_char(c.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS created_at_text,
              o.name AS owner_name,
              COALESCE((SELECT sum(p.amount)::int FROM cons_pay p WHERE p.cons_id=c.id),0) AS paid,
              (SELECT i.id FROM inv i WHERE i.cs_id=c.id AND i.state<>'void') AS inv_id
         FROM cons c LEFT JOIN staff o ON o.id=c.owner_id WHERE c.id=$1 AND c.deleted_at IS NULL`, [consId],
    );
    // 정상 경로에서는 SHARE lock 때문에 사라질 수 없지만, 오염/드라이버 경계도 500으로 새지 않게 한다.
    if (!detail) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    const students = await q(`SELECT s.id,s.name FROM cons_stu x JOIN stu s ON s.id=x.student_id WHERE x.cons_id=$1 ORDER BY s.name,s.id`, [consId]);
    const picked = await q(`SELECT s.id,s.name FROM cons_pick x JOIN staff s ON s.id=x.staff_id WHERE x.cons_id=$1 ORDER BY s.name,s.id`, [consId]);
    const fileRows = await q(
      `SELECT f.id,f.name,f.mime,f.bytes,cf.role,s.name AS by_name,
              to_char(cf.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at
         FROM cons_file cf JOIN file f ON f.id=cf.file_id LEFT JOIN staff s ON s.id=cf.created_by
        WHERE cf.cons_id=$1 ORDER BY cf.created_at,cf.file_id`, [consId],
    );
    const files = fileRows.map((f): ConsultingFileDto => ({
      id: Number(f.id), name: String(f.name), mime: String(f.mime), bytes: Number(f.bytes),
      url: fileUrlOf(Number(f.id)), role: String(f.role) as ConsultingFileRole,
      uploadedByName: (f.by_name as string) ?? null, uploadedAt: String(f.at),
    }));
    const feedbackRows = await q(
      `SELECT f.id,f.body,c.name AS created_by_name,r.name AS resolved_by_name,
              to_char(f.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS created_at_text,
              CASE WHEN f.resolved_at IS NULL THEN NULL ELSE to_char(f.resolved_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' END AS resolved_at_text
         FROM cons_feedback f LEFT JOIN staff c ON c.id=f.created_by LEFT JOIN staff r ON r.id=f.resolved_by
        WHERE f.cons_id=$1 ORDER BY f.created_at,f.id`, [consId],
    );
    const feedback = feedbackRows.map((f): ConsultingFeedbackDto => this.feedbackDto(f));
    const [delivery] = await q(
      `SELECT to_char(e.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at,s.name AS by_name
         FROM cons_event e LEFT JOIN staff s ON s.id=e.by_id
        WHERE e.cons_id=$1 AND e.event_type='parent_delivered' ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [consId],
    );
    /* C95 — 회차·필수 항목·종료 도장. 세는 것은 전부 여기다 (D-R37) */
    const today = todayKst();
    const [counts] = await q<{ done: number; planned: number; required_left: number }>(
      `SELECT (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND (x.on_date IS NULL OR x.on_date <= $2::date)) AS done,
              (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND x.on_date > $2::date) AS planned,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id=$1 AND i.required AND NOT i.done) AS required_left`,
      [consId, today],
    );
    const [closedEvent] = await q(
      `SELECT to_char(e.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at,s.name AS by_name
         FROM cons_event e LEFT JOIN staff s ON s.id=e.by_id
        WHERE e.cons_id=$1 AND e.event_type='closed' ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [consId],
    );
    const step = detail.contract_step == null ? null : Number(detail.contract_step);
    const stage = String(detail.stage) as ConsultingRecord['stage'];
    const contractFiles = files.filter((f) => f['role'] !== 'signed');
    const signedFiles = files.filter((f) => f['role'] === 'signed');
    const unresolved = feedback.filter((f) => !f.resolved).length;
    const paid = Number(detail.paid);
    const amount = detail.amount == null ? null : Number(detail.amount);
    const due = amount == null ? null : amount - paid;
    const invId = detail.inv_id == null ? null : Number(detail.inv_id);
    const mutable = stage === 'contract';
    const consType = String(detail.cons_type);
    const knownType = consType as ConsultingType;
    const sessionsDone = Number(counts?.done ?? 0);
    const sessionsPlanned = Number(counts?.planned ?? 0);
    const requiredLeft = Number(counts?.required_left ?? 0);
    const closeIssue = consultingCloseIssue({
      stage, sessions: detail.sessions == null ? null : Number(detail.sessions), sessionsDone, requiredLeft,
    });
    return {
      id: consId,
      consType,
      consTypeLabel: CONSULTING_TYPE_LABEL[knownType] ?? consType,
      stage,
      contractStep: step,
      studentIds: students.map((s) => Number(s.id)),
      studentNames: students.map((s) => String(s.name)),
      requester: detail.requester == null ? null : String(detail.requester) as ConsultingDetailDto['requester'],
      ownerId: detail.owner_id == null ? null : Number(detail.owner_id),
      ownerName: (detail.owner_name as string) ?? null,
      startOn: (detail.start_on_text as string) ?? null,
      endOn: (detail.end_on_text as string) ?? null,
      // §29·§30 계약 작성 상세의 입력값. 회계 목록/수납 API의 canMoney projection과 분리한다.
      amount,
      sessions: detail.sessions == null ? null : Number(detail.sessions),
      share,
      pickedStaffIds: picked.map((s) => Number(s.id)),
      pickedStaffNames: picked.map((s) => String(s.name)),
      createdAt: String(detail.created_at_text),
      typeCapability: consType === 'admissions'
        ? {
          defaultItemsSupported: true, reason: null,
          scheduleCreationSupported: false, scheduleCreationReason: '실제 일정 생성 규칙이 확정되지 않아 약정 회차만 저장합니다',
        }
        : {
          defaultItemsSupported: false, reason: '이 유형의 기본 항목 템플릿은 아직 확정되지 않았습니다',
          scheduleCreationSupported: false, scheduleCreationReason: '실제 일정 생성 규칙이 확정되지 않아 약정 회차만 저장합니다',
        },
      capabilities: {
        canEdit: mutable,
        canChangeShare: mutable,
        // 범위를 바꾸는 것과 **비공개를 고르는 것**은 다른 층이다 — §76 대표 전용 (S4)
        canSetPrivate: canHide,
        canAddContractFile: mutable && (step === 1 || step === 2 || step === 4) && files.length < CONSULTING_FILE_MAX,
        canRemoveContractFile: mutable && (step === 1 || step === 2) && feedback.length === 0 && contractFiles.length > 0,
        canAddFeedback: mutable && step === 2 && contractFiles.length > 0,
        canResolveFeedback: mutable && step === 2 && unresolved > 0,
        canDeliver: mutable && step === 2 && contractFiles.length > 0 && unresolved === 0,
        canAddSignedFile: mutable && step === 4 && Boolean(delivery) && files.length < CONSULTING_FILE_MAX,
        canAddPayment: canMoney && step === 5 && stage !== 'done' && (due === null || due > 0),
        canCreateInvoice: canMoney && invId === null && this.invoiceable(step, due),
        canArchive: true,
        externalParentSendSupported: false,
        externalParentSendReason: '학부모 연락처와 발송 채널 정책이 없어 전달 완료 사실만 기록합니다',
        canAddSession: consultingSessionAddIssue(stage) === null,
        canClose: closeIssue === null,
        closeBlockedReason: closeIssue?.message ?? null,
      },
      contractFiles,
      signedFiles,
      feedback,
      delivery: delivery ? { deliveredAt: String(delivery.at), deliveredByName: (delivery.by_name as string) ?? null } : null,
      payment: { paid: canMoney ? paid : null, due: canMoney ? due : null, invoiceId: canMoney ? invId : null },
      sessionsDone,
      sessionsPlanned,
      requiredLeft,
      closedAt: closedEvent ? String(closedEvent.at) : null,
      closedByName: closedEvent ? ((closedEvent.by_name as string) ?? null) : null,
    };
  }

  async updateShare(viewerId: number, canMoney: boolean, canHide: boolean, consId: number, dto: ConsultingShareUpdateDto): Promise<ConsultingDetailDto> {
    const picked = this.assertPicked(dto.share, dto.pickedStaffIds);
    this.assertCanSetPrivate(dto.share, canHide);
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract') {
        throw new ConflictException({ code: 'CONS_LOCKED', message: '계약 단계에서만 공개 범위를 바꿀 수 있습니다' });
      }
      this.assertNoSelfLockout(dto.share, c.owner_id == null ? null : Number(c.owner_id), picked, viewerId, canHide);
      await this.assertActiveAdminStaff(m, picked);
      await m.query(`DELETE FROM cons_pick WHERE cons_id=$1`, [consId]);
      if (picked.length) await m.query(`INSERT INTO cons_pick (cons_id,staff_id) SELECT $1,unnest($2::bigint[])`, [consId, picked]);
      await m.query(`UPDATE cons SET share=$2 WHERE id=$1`, [consId, dto.share]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'share_changed',$2)`, [consId, viewerId]);
    });
    return this.detail(viewerId, canMoney, canHide, consId);
  }

  private feedbackDto(r: R): ConsultingFeedbackDto {
    const resolvedAt = (r.resolved_at_text as string) ?? null;
    return {
      id: Number(r.id), body: String(r.body), createdByName: (r.created_by_name as string) ?? null,
      createdAt: String(r.created_at_text), resolved: resolvedAt !== null,
      resolvedByName: (r.resolved_by_name as string) ?? null, resolvedAt,
    };
  }

  private async readFile(m: EntityManager, fileId: number): Promise<ConsultingFileDto> {
    const [f] = (await m.query(
      `SELECT f.id,f.name,f.mime,f.bytes,cf.role,s.name AS by_name,
              to_char(cf.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at
         FROM cons_file cf JOIN file f ON f.id=cf.file_id LEFT JOIN staff s ON s.id=cf.created_by WHERE f.id=$1`, [fileId],
    )) as R[];
    return { id: Number(f.id), name: String(f.name), mime: String(f.mime), bytes: Number(f.bytes), url: fileUrlOf(Number(f.id)), role: String(f.role) as ConsultingFileRole, uploadedByName: (f.by_name as string) ?? null, uploadedAt: String(f.at) };
  }

  async addContractFile(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const step = c.contract_step == null ? null : Number(c.contract_step);
      if (String(c.stage) !== 'contract' || (step !== 1 && step !== 2 && step !== 4)) {
        throw new ConflictException({ code: 'CONS_FILE_LOCKED', message: '계약서 작성·피드백 단계에서만 계약 파일을 추가합니다' });
      }
      const [{ count }] = (await m.query(`SELECT count(*)::int AS count FROM cons_file WHERE cons_id=$1`, [consId])) as Array<{ count: number }>;
      if (count >= CONSULTING_FILE_MAX) throw new ConflictException({ code: 'CONS_FILE_LIMIT', message: '계약 관련 파일은 최대 10개입니다' });
      const [{ drafts }] = (await m.query(`SELECT count(*)::int AS drafts FROM cons_file WHERE cons_id=$1 AND role<>'signed'`, [consId])) as Array<{ drafts: number }>;
      const role: ConsultingFileRole = drafts === 0 ? 'draft' : 'revision';
      const file = await storeFile(m, viewerId, { kind: 'cons-contract', name: dto.name, base64: dto.base64 });
      await m.query(`INSERT INTO cons_file (file_id,cons_id,role,created_by) VALUES ($1,$2,$3,$4)`, [file.id, consId, role, viewerId]);
      if (step === 1 || step === 4) await m.query(`UPDATE cons SET contract_step=2 WHERE id=$1`, [consId]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_added',$2,$3)`, [consId, file.id, viewerId]);
      return this.readFile(m, file.id);
    });
  }

  async removeContractFile(viewerId: number, canHide: boolean, consId: number, fileId: number): Promise<void> {
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const step = c.contract_step == null ? null : Number(c.contract_step);
      if (String(c.stage) !== 'contract' || (step !== 1 && step !== 2)) {
        throw new ConflictException({ code: 'CONS_FILE_LOCKED', message: '전달 전 계약 파일만 제거할 수 있습니다' });
      }
      const [{ feedback }] = (await m.query(`SELECT count(*)::int AS feedback FROM cons_feedback WHERE cons_id=$1`, [consId])) as Array<{ feedback: number }>;
      if (feedback > 0) throw new ConflictException({ code: 'CONS_FILE_HAS_FEEDBACK', message: '피드백 이력이 있는 계약 파일은 제거할 수 없습니다' });
      const [linked] = (await m.query(`SELECT file_id FROM cons_file WHERE cons_id=$1 AND file_id=$2 AND role<>'signed' FOR UPDATE`, [consId, fileId])) as R[];
      if (!linked) throw new NotFoundException('계약 파일을 찾을 수 없습니다');
      await m.query(`DELETE FROM cons_file WHERE file_id=$1`, [fileId]);
      await m.query(`DELETE FROM file WHERE id=$1`, [fileId]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_removed',$2,$3)`, [consId, fileId, viewerId]);
      const [{ left }] = (await m.query(`SELECT count(*)::int AS left FROM cons_file WHERE cons_id=$1 AND role<>'signed'`, [consId])) as Array<{ left: number }>;
      if (left === 0) await m.query(`UPDATE cons SET contract_step=1 WHERE id=$1`, [consId]);
    });
  }

  async addFeedback(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFeedbackCreateDto): Promise<ConsultingFeedbackDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract' || Number(c.contract_step) !== 2) {
        throw new ConflictException({ code: 'CONS_FEEDBACK_LOCKED', message: '계약서 피드백 단계가 아닙니다' });
      }
      const [{ files }] = (await m.query(`SELECT count(*)::int AS files FROM cons_file WHERE cons_id=$1 AND role<>'signed'`, [consId])) as Array<{ files: number }>;
      if (files === 0) throw new ConflictException({ code: 'CONS_CONTRACT_FILE_REQUIRED', message: '계약서를 먼저 올려야 합니다' });
      const [created] = (await m.query(
        `INSERT INTO cons_feedback (cons_id,body,created_by) VALUES ($1,$2,$3) RETURNING id`,
        [consId, dto.body.trim(), viewerId],
      )) as Array<{ id: string }>;
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'feedback_added',$2,$3)`, [consId, created.id, viewerId]);
      const [row] = (await m.query(
        `SELECT f.id,f.body,s.name AS created_by_name,NULL::text AS resolved_by_name,
                to_char(f.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS created_at_text,
                NULL::text AS resolved_at_text
           FROM cons_feedback f LEFT JOIN staff s ON s.id=f.created_by WHERE f.id=$1`, [created.id],
      )) as R[];
      return this.feedbackDto(row);
    });
  }

  async markFeedbackResolved(viewerId: number, canHide: boolean, consId: number, feedbackId: number): Promise<ConsultingFeedbackDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract' || Number(c.contract_step) !== 2) {
        throw new ConflictException({ code: 'CONS_FEEDBACK_LOCKED', message: '계약서 피드백 단계가 아닙니다' });
      }
      const [existing] = (await m.query(`SELECT id,resolved_at FROM cons_feedback WHERE id=$1 AND cons_id=$2 FOR UPDATE`, [feedbackId, consId])) as R[];
      if (!existing) throw new NotFoundException('피드백을 찾을 수 없습니다');
      if (existing.resolved_at == null) {
        await m.query(`UPDATE cons_feedback SET resolved_at=now(),resolved_by=$3 WHERE id=$1 AND cons_id=$2 AND resolved_at IS NULL`, [feedbackId, consId, viewerId]);
        await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'feedback_resolved',$2,$3)`, [consId, feedbackId, viewerId]);
      }
      const [row] = (await m.query(
        `SELECT f.id,f.body,c.name AS created_by_name,r.name AS resolved_by_name,
                to_char(f.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS created_at_text,
                to_char(f.resolved_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS resolved_at_text
           FROM cons_feedback f LEFT JOIN staff c ON c.id=f.created_by LEFT JOIN staff r ON r.id=f.resolved_by WHERE f.id=$1`, [feedbackId],
      )) as R[];
      return this.feedbackDto(row);
    });
  }

  async deliverContract(viewerId: number, canMoney: boolean, canHide: boolean, consId: number): Promise<ConsultingDetailDto> {
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const step = Number(c.contract_step);
      if (String(c.stage) !== 'contract' || (step !== 2 && step !== 4)) {
        throw new ConflictException({ code: 'CONS_DELIVERY_LOCKED', message: '피드백 완료 뒤 계약서를 전달합니다' });
      }
      if (step === 4) return; // 재시도는 현재 단계에서 멱등이다. 수정본을 올리면 다시 step 2가 된다.
      const [{ files, unresolved }] = (await m.query(
        `SELECT
           (SELECT count(*)::int FROM cons_file WHERE cons_id=$1 AND role<>'signed') AS files,
           (SELECT count(*)::int FROM cons_feedback WHERE cons_id=$1 AND resolved_at IS NULL) AS unresolved`, [consId],
      )) as Array<{ files: number; unresolved: number }>;
      if (files === 0) throw new ConflictException({ code: 'CONS_CONTRACT_FILE_REQUIRED', message: '계약서를 먼저 올려야 합니다' });
      if (unresolved > 0) throw new ConflictException({ code: 'CONS_FEEDBACK_OPEN', message: '해결되지 않은 피드백이 있습니다' });
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'parent_delivered',$2)`, [consId, viewerId]);
      await m.query(`UPDATE cons SET contract_step=4 WHERE id=$1`, [consId]);
    });
    return this.detail(viewerId, canMoney, canHide, consId);
  }

  async addSignedFile(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract' || Number(c.contract_step) !== 4) {
        throw new ConflictException({ code: 'CONS_SIGNED_LOCKED', message: '학부모 전달 뒤 서명본을 등록합니다' });
      }
      const [{ count, deliveries }] = (await m.query(
        `SELECT (SELECT count(*)::int FROM cons_file WHERE cons_id=$1) AS count,
                (SELECT count(*)::int FROM cons_event WHERE cons_id=$1 AND event_type='parent_delivered') AS deliveries`, [consId],
      )) as Array<{ count: number; deliveries: number }>;
      if (deliveries === 0) throw new ConflictException({ code: 'CONS_DELIVERY_REQUIRED', message: '학부모 전달 기록이 필요합니다' });
      if (count >= CONSULTING_FILE_MAX) throw new ConflictException({ code: 'CONS_FILE_LIMIT', message: '계약 관련 파일은 최대 10개입니다' });
      const file = await storeFile(m, viewerId, { kind: 'cons-contract', name: dto.name, base64: dto.base64 });
      await m.query(`INSERT INTO cons_file (file_id,cons_id,role,created_by) VALUES ($1,$2,'signed',$3)`, [file.id, consId, viewerId]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_added',$2,$3)`, [consId, file.id, viewerId]);
      await m.query(`UPDATE cons SET contract_step=5 WHERE id=$1`, [consId]);
      return this.readFile(m, file.id);
    });
  }

  async archive(viewerId: number, canHide: boolean, consId: number): Promise<void> {
    await this.anyRepo.manager.transaction(async (m) => {
      await this.lockFull(m, viewerId, canHide, consId);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'archived',$2)`, [consId, viewerId]);
      await m.query(`UPDATE cons SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL`, [consId, viewerId]);
    });
  }

  async all(viewerId: number, canMoney: boolean, canHide: boolean): Promise<ConsultingListDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              c.requester,
              to_char(c.end_on,'YYYY-MM-DD')      AS end_on,
              to_char(c.created_at,'YYYY-MM-DD')  AS created_at,
              o.name AS owner_name,
              -- 원본 카드의 금액쌍 왼쪽 반. 청구서 입금과 **다른 표**다 (CONS_PAY)
              COALESCE((SELECT sum(p.amount) FROM cons_pay p WHERE p.cons_id = c.id), 0) AS paid_amount,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              COALESCE(
                (SELECT array_agg(s.name ORDER BY s.name)
                   FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                  WHERE cs.cons_id = c.id), '{}') AS student_names
         FROM cons c LEFT JOIN staff o ON o.id = c.owner_id
        WHERE c.deleted_at IS NULL
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
    const today = todayKst();
    for (const r of logs) {
      const k = Number(r.cons_id);
      if (!byCons.has(k)) byCons.set(k, []);
      const onDate = (r.on_date as string) ?? null;
      byCons.get(k)!.push({
        id: Number(r.id), seq: Number(r.seq), onDate,
        who: (r.who as string) ?? null, what: (r.what as string) ?? null,
        why: (r.why as string) ?? null, how: (r.how as string) ?? null,
        serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
        // 기록 ≠ 완료 (N-18) — 앞으로 잡아 둔 날짜는 아직 한 회차가 아니다
        done: consultingSessionDone(onDate, today),
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
        /* 원본 §26 카드의 낱말과 수 — 화면이 만들지 않는다 (D-R18 · D-R37 · C86-e) */
        stageLabel: consultingStageLabel(record.stage),
        typeLabel: CONSULTING_TYPE_LABEL[String(r.cons_type) as ConsultingType] ?? String(r.cons_type),
        shareLabel: consShareLabel(share),
        contractStepLabel: consultingContractStepLabel(record.contractStep),
        requesterLabel: consultingRequesterLabel(r.requester as string | null),
        ageDays: daysSince(String(r.created_at)),
        // 받은 돈도 **계약 금액과 같은 권한**을 탄다 — 한쪽만 보이면 나머지가 빼기로 드러난다
        paidAmount: money ? Number(r.paid_amount ?? 0) : null,
        // 내용이 안 열리면 회차 기록도 내려보내지 않는다 — 화면에서 감추는 건 감춘 게 아니다
        sessionsLog: full ? (byCons.get(Number(r.id)) ?? []) : [],
        sessionsDone: full ? (byCons.get(Number(r.id)) ?? []).filter((x) => x.done).length : 0,
        items: full ? (itemsByCons.get(Number(r.id)) ?? []) : [],
      };
    });

    return {
      items,
      canSeeAmounts: canMoney,
      // 「비공개」를 고를 수 있는가 — 단추와 서버가 같은 질문을 한다 (D-R39 · S4)
      canSetPrivate: canHide,
      // 빈 칸도 이름과 한 줄을 갖는다 — 화면이 칸을 만들면 순서와 낱말이 갈린다 (D-R18 · D-R25)
      stages: CONSULTING_STAGES.map((key) => ({
        key, label: CONSULTING_STAGE_LABEL[key], sub: CONSULTING_STAGE_SUB[key],
      })),
    };
  }

  /**
   * §31 항목 체크/해제 — 47D-B 의 유일한 쓰기. 공개 범위(csCanFull)와 종료 잠금은 서버가 판정한다.
   * 보이지 않는 건은 404(존재 누출 금지), 내용 잠김은 403, 종료 건은 409 ITEM_LOCKED.
   */
  async toggleItem(viewerId: number, canHide: boolean, consId: number, itemId: number, dto: ConsItemToggleDto): Promise<ConsItemDto> {
    const [c] = await this.q(
      `SELECT c.id, c.stage, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $2) AS is_picked
         FROM cons c WHERE c.id = $1 AND c.deleted_at IS NULL`, [consId, viewerId]);
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

  /** 상세 읽기의 권한 판정과 CONS 공유 잠금. 보이지 않으면 404로 존재를 숨긴다. */
  private async gate(
    m: EntityManager, viewerId: number, canHide: boolean, canMoney: boolean, consId: number,
  ): Promise<{ row: R; share: ConsShare; viewer: ConsViewer }> {
    const [c] = (await m.query(
      `SELECT c.id, c.stage, c.contract_step, c.amount, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $2) AS is_picked
         FROM cons c WHERE c.id = $1 AND c.deleted_at IS NULL FOR SHARE OF c`, [consId, viewerId])) as R[];
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
         FROM cons c WHERE c.deleted_at IS NULL
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
    if (dto.paidOn > todayKst()) throw new BadRequestException('납부일이 오늘보다 뒤일 수 없습니다');
    await this.anyRepo.manager.transaction(async (m) => {
      const { row: locked, share, viewer } = await this.lockVisible(m, viewerId, canHide, canMoney, consId);
      if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');
      if (String(locked.stage) === 'done') {
        throw new ConflictException({ code: 'CONS_PAY_LOCKED', message: '종료된 컨설팅에는 납부를 더할 수 없습니다' });
      }
      // C79 신규 계약은 서명본(step 5) 전 수납을 막는다. 레거시 행은 기존 회계 계약을 보존한다.
      const c79 = locked.start_on != null || locked.requester != null;
      if (c79 && Number(locked.contract_step) !== CONTRACT_STEP_MAX) {
        throw new ConflictException({ code: 'CONS_PAY_NOT_READY', message: '서명본 등록 뒤 수납할 수 있습니다' });
      }
      const amount = locked.amount == null ? null : Number(locked.amount);
      const [{ paid: paidBefore }] = (await m.query(
        `SELECT COALESCE(sum(amount),0)::int AS paid FROM cons_pay WHERE cons_id=$1`, [consId],
      )) as Array<{ paid: number }>;
      const before = Number(paidBefore);
      if (amount !== null && before + dto.amount > amount) {
        throw new ConflictException({
          code: 'OVERPAY',
          message: `남은 금액은 ${Math.max(0, amount - before)}원입니다 — 그보다 많이 적을 수 없습니다`,
        });
      }
      const [pay] = (await m.query(
        `INSERT INTO cons_pay (cons_id,amount,paid_on,memo,by_id) VALUES ($1,$2,$3::date,$4,$5) RETURNING id`,
        [consId, dto.amount, dto.paidOn, dto.memo?.trim() || null, viewerId],
      )) as Array<{ id: string }>;
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'payment_added',$2,$3)`, [consId, pay.id, viewerId]);
      const paid = before + dto.amount;
      // N-18: 확인된 누적 수납이 계약 금액에 도달했을 때만 진행으로 자동 전이한다.
      if (String(locked.stage) === 'contract' && Number(locked.contract_step) === CONTRACT_STEP_MAX && amount !== null && paid >= amount) {
        await m.query(`UPDATE cons SET stage='running' WHERE id=$1 AND stage='contract' AND contract_step=$2`, [consId, CONTRACT_STEP_MAX]);
      }
    });
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
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      // 같은 건을 두 번 눌러도 청구서는 하나다 — 잠그고 다시 센다 (inv_cs_id_live_uniq 가 최후 방어)
      const { row: c, share, viewer } = await this.lockVisible(m, viewerId, canHide, canMoney, consId);
      if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');
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

  /* ══ §27 컨설팅 학생별 (C59) ═══════════════════════════════════════════
   * 원문 슬라이드 27 — 데이터 「CONS 를 학생 기준으로 재구성」 · 동작 「학생 클릭 → 그 학생의
   * 컨설팅 목록」 · 규칙 「**csCan() 으로 볼 수 있는 것만 집계합니다**」 ·
   * 연동 「공개 범위가 solo/some 이면 목록에서도 빠집니다」.
   *
   * 규칙 줄이 곧 구현이다 — 보이는 건만 골라 놓고 그 위에서 센다. 안 보이는 건을 세었다가
   * 화면에서 감추면 **「컨설팅 2건」이라 적어 놓고 한 건만 보이는 화면**이 된다.
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 학생 기준 재구성. 한 건에 학생이 여럿이면 **그 학생들 모두의 줄에 걸린다** —
   * 원문이 「학생 여러 명」을 허용하므로(슬라이드 29) 한 명에게만 붙이면 나머지가 사라진다.
   *
   * 세는 것은 전부 서버다 (D-R37) — 기록 회차 · 끝낸 항목 · 받은 돈 · 건수.
   * 화면이 `items.length` 를 세면 **내용이 잠긴 건에서 분모가 0** 이 되어 「항목 0/0」이 된다.
   */
  async students(viewerId: number, canMoney: boolean, canHide: boolean): Promise<ConsStudentsDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              to_char(c.end_on,'YYYY-MM-DD')     AS end_on,
              to_char(c.created_at,'YYYY-MM-DD') AS created_on,
              o.name AS owner_name,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              (SELECT count(*)::int FROM cons_sess s WHERE s.cons_id = c.id)                 AS sessions_logged,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id = c.id)                 AS items_total,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id = c.id AND i.done)      AS items_done,
              COALESCE((SELECT sum(p.amount)::int FROM cons_pay p WHERE p.cons_id = c.id), 0) AS paid
         FROM cons c LEFT JOIN staff o ON o.id = c.owner_id
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC, c.id`,
      [viewerId],
    );

    const visible = rows.flatMap((r) => {
      const share = String(r.share) as ConsShare;
      const viewer: ConsViewer = {
        isOwner: r.owner_id !== null && Number(r.owner_id) === viewerId,
        isPicked: r.is_picked === true, canHide, canMoney,
      };
      return csCan(share, viewer)
        ? [{ r, full: csCanFull(share, viewer), money: csCanAmount(share, viewer) }]
        : [];
    });
    if (visible.length === 0) return { items: [], canSeeAmounts: canMoney };

    const ids = visible.map(({ r }) => Number(r.id));
    const fullIds = visible.filter(({ full }) => full).map(({ r }) => Number(r.id));
    const linkRows = await this.q(
      `SELECT cs.cons_id, s.id AS student_id, s.name, s.grade
         FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
        WHERE cs.cons_id = ANY($1::bigint[])
        ORDER BY s.name, s.id`,
      [ids],
    );
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

    const caseOf = (r: R, money: boolean, full: boolean): ConsStudentCaseDto => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: r.sessions };
      assertRecord(record);
      return {
        id: Number(r.id),
        consType: String(r.cons_type),
        stage: record.stage,
        stageLabel: consultingStageLabel(record.stage),
        createdOn: String(r.created_on),
        endOn: (r.end_on as string) ?? null,
        ownerName: (r.owner_name as string) ?? null,
        sessionsLogged: Number(r.sessions_logged),
        sessions: record.sessions,
        itemsDone: Number(r.items_done),
        itemsTotal: Number(r.items_total),
        amount: money && r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
        paid: money ? Number(r.paid) : null,
        items: full ? (itemsByCons.get(Number(r.id)) ?? []) : [],
      };
    };

    const byCons = new Map(visible.map((v) => [Number(v.r.id), v]));
    const students = new Map<number, ConsStudentDto>();
    for (const l of linkRows) {
      const v = byCons.get(Number(l.cons_id));
      if (!v) continue; // 안 보이는 건은 학생 줄에도 안 걸린다
      const sid = Number(l.student_id);
      if (!students.has(sid)) {
        students.set(sid, {
          studentId: sid, name: String(l.name), grade: (l.grade as string) ?? null,
          caseCount: 0, amount: canMoney ? 0 : null, paid: canMoney ? 0 : null, cases: [],
        });
      }
      const s = students.get(sid)!;
      const c = caseOf(v.r, v.money, v.full);
      s.cases.push(c);
      s.caseCount += 1;
      // 금액이 가려진 건은 학생 합계에도 안 들어간다 — 합계로 가려진 금액이 드러나면 안 된다
      if (canMoney && v.money) {
        s.amount = (s.amount ?? 0) + (c.amount ?? 0);
        s.paid = (s.paid ?? 0) + (c.paid ?? 0);
      }
    }

    // 이름 순 — 왼쪽 줄의 차례다. 원문 컷도 이름으로 서 있다.
    const items = [...students.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return { items, canSeeAmounts: canMoney };
  }
}
