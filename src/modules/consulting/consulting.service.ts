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
import { AUDIT_WRITES, audit } from '../../lib/audit';
import { todayKst } from '../../lib/kst';
import { assertMonthOpenForWrite } from '../../lib/month-close';
import { NOTI_TITLE } from '../../lib/noti';
import { END_MIN, START_MIN, kstAt, kstDateOf, writtenRows } from '../../lib/sql';
import { CONS_SHARES, csCan, csCanAmount, csCanFull, type ConsShare, type ConsViewer } from '../../lib/rules';
import { lineAmountVisible, readAcctPrivacy } from '../../lib/acct-privacy';
import { INV_TYPE_LABEL } from '../accounting/accounting.dto';
import { fileUrlOf, storeFile } from '../files/files.service';
import type { SendAttachment } from '../notify/sender';
import type {
  ConsAccountingDto, ConsAccountRowDto, ConsItemDto, ConsItemsEditDto, ConsItemToggleDto,
  ConsPaymentCreateDto, ConsPaymentDto, ConsStudentCaseDto, ConsStudentDto, ConsStudentsDto, ConsToInvoiceDto,
  ConsultingCreateDto, ConsultingDetailDto, ConsultingPatchDto,
  ConsultingFeedbackCreateDto, ConsultingFeedbackDto, ConsultingFileDto, ConsultingListDto,
  ConsultingFileCreateDto, ConsultingSessionDto, ConsultingShareUpdateDto,
} from './consulting.dto';
import {
  CONS_ITEM_MAX,
  CONSULTING_CONTRACT_STEPS, CONSULTING_CONTRACT_STEP_SUB,
  CONSULTING_FILE_MAX, CONSULTING_STAGES, CONSULTING_STAGE_LABEL, CONSULTING_STAGE_SUB,
  CONSULTING_TYPE_LABEL, CONTRACT_STEP_MAX, INTERNATIONAL_SCHOOL_ITEMS,
  consItemEditIssue, consPaidSql,
  consSessDoneSql, consShareChipLabel, consShareLabel, consShareMeaning, consultingAgeDays, consultingArchiveIssue,
  consultingCloseIssue, consultingContractStepLabel, consultingExceptionCloseIssue, consultingRecordIssue,
  consultingRequesterWords, consultingTypeLabel, consultingTypeWords,
  consultingSessionRecorded,
  consultingRemainingMessage, consultingRequesterLabel,
  consultingSessionAddIssue, consultingSessionDone, consultingSessionIssue, consultingStageLabel,
  type ConsultingFileRole, type ConsultingType,
  type ConsultingRecord,
} from './consulting.rules';
import { lockPayRequestKey, priorConsPayForKey } from '../../lib/pay-request-key';

type R = Record<string, unknown>;

/**
 * §31 진행 항목 한 줄 — SELECT 와 매핑이 **여기 하나**다. 목록 · 학생별 · 항목 체크 응답이 같은 칸을 읽는다
 * (셋이 따로 적고 있어 처리 시각(31-04)을 한 곳에만 더하면 나머지가 낡았다 · D-R22).
 */
const CONS_ITEM_SELECT = `SELECT i.id, i.cons_id, i.seq, i.label, i.required, i.done, i.source,
              to_char(${kstDateOf('i.done_at')},'YYYY-MM-DD') AS done_on,
              CASE WHEN i.done_at IS NULL THEN NULL ELSE ${kstAt('i.done_at')} END AS done_at_text,
              s.name AS done_by_name
         FROM cons_item i LEFT JOIN staff s ON s.id = i.done_by`;

/**
 * 항목 한 줄 + 그 항목의 파일 · 단추 셋(W11 · N-63 · N-18-a). 단추는 쓰기와 **같은 판정**(`consItemEditIssue`)에서 나온다 (D-R39).
 * @param stage 건의 단계 — 종료된 건의 항목은 바꾸지 않는다
 */
function consItemDto(r: R, files: ConsultingFileDto[], stage: string): ConsItemDto {
  const facts = { stage, done: r.done === true, source: String(r.source), files: files.length };
  return {
    id: Number(r.id), seq: Number(r.seq), label: String(r.label),
    required: r.required === true, done: r.done === true, source: String(r.source),
    doneBy: (r.done_by_name as string) ?? null, doneOn: (r.done_on as string) ?? null,
    doneAt: (r.done_at_text as string) ?? null,
    files,
    canAddFile: consItemEditIssue('file', facts) === null,
    canRename: consItemEditIssue('rename', facts) === null,
    canRemove: consItemEditIssue('remove', facts) === null,
  };
}

/**
 * 컨설팅 파일 한 줄 — SELECT 칸과 매핑이 **여기 하나**다. 계약 파일 · 서명본 · 항목 파일이 같은 모양을 쓴다
 * (상세와 올린 뒤 응답이 같은 매핑을 두 벌 적고 있었다 · D-R22).
 */
const CONS_FILE_COLS = `f.id, f.name, f.mime, f.bytes, cf.role, cf.item_id, s.name AS by_name,
              to_char(cf.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at`;
const CONS_FILE_FROM = `FROM cons_file cf JOIN file f ON f.id=cf.file_id LEFT JOIN staff s ON s.id=cf.created_by`;

function consFileDto(f: R): ConsultingFileDto {
  return {
    id: Number(f.id), name: String(f.name), mime: String(f.mime), bytes: Number(f.bytes),
    url: fileUrlOf(Number(f.id)), role: String(f.role) as ConsultingFileRole,
    uploadedByName: (f.by_name as string) ?? null, uploadedAt: String(f.at),
  };
}

/** 계약서 전달(N-77) — 메일 한 통에 붙이는 파일의 상한. 파일 하나는 FILE 표의 3MB 한도 그대로다 */
export const CONS_DELIVERY_FILES_MAX = 5;
export const CONS_DELIVERY_BYTES_MAX = 10_000_000;

/** 예외 종료의 감사 줄(N-18-a) — entity · action 낱말은 감사 표 한 곳(`lib/audit`)에서 읽는다. 상세가 그 줄의 사유를 되읽는다 */
const CLOSE_EXCEPTION_AUDIT = AUDIT_WRITES.find((w) => w.key === 'consulting.close_exception')!;

/**
 * §31 회차 한 줄 — SELECT 와 매핑이 **여기 하나**다(목록 · 회차 고치기 응답 · 31-07 · 31-08).
 * 회차 머리의 시각 · 담당 · 강의실은 **이어진 시간표 회차에서 읽는다** — 같은 사실을 `cons_sess` 에 또 적지 않는다(D-R22).
 * 규칙이 원래 찍은 날(`o.on_date`)과 그려지는 날이 다를 수 있어(옮긴 회차) 그려지는 날이 같은 줄을 먼저 고른다.
 */
export const CONS_SESS_SELECT = `SELECT x.id, x.cons_id, x.seq, to_char(x.on_date,'YYYY-MM-DD') AS on_date,
              x.who, x.what, x.why, x.how, x.ser_id, x.result, x.next_until,
              oc.start_min, oc.end_min, oc.staff_name, oc.room_name
         FROM cons_sess x
         LEFT JOIN LATERAL (
           SELECT ${START_MIN} AS start_min, ${END_MIN} AS end_min, st.name AS staff_name, rm.name AS room_name
             FROM ser_occ o JOIN ser s ON s.id = o.ser_id
             LEFT JOIN staff st ON st.id = COALESCE(o.teacher_id, s.teacher_id)
             LEFT JOIN room rm ON rm.id = COALESCE(o.room_id, s.room_id)
            WHERE o.ser_id = x.ser_id AND (o.on_date = x.on_date OR ${kstDateOf('lower(o.span)')} = x.on_date)
            ORDER BY (${kstDateOf('lower(o.span)')} = x.on_date) DESC, o.id
            LIMIT 1
         ) oc ON true`;

export function consSessDto(r: R, today: string): ConsultingSessionDto {
  const onDate = (r.on_date as string) ?? null;
  const text = (v: unknown) => (v as string) ?? null;
  return {
    id: Number(r.id), seq: Number(r.seq), onDate,
    who: text(r.who), what: text(r.what), why: text(r.why), how: text(r.how),
    serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
    // 기록 ≠ 완료 (N-18) — 앞으로 잡아 둔 날짜는 아직 한 회차가 아니다
    done: consultingSessionDone(onDate, today),
    startMin: r.start_min == null ? null : Number(r.start_min),
    endMin: r.end_min == null ? null : Number(r.end_min),
    staffName: text(r.staff_name), roomName: text(r.room_name),
    recorded: consultingSessionRecorded({ what: text(r.what), why: text(r.why), how: text(r.how) }),
    result: text(r.result), nextUntil: text(r.next_until),
  };
}

function assertRecord(record: { stage: unknown; contractStep: unknown; sessions: unknown }): asserts record is ConsultingRecord {
  if (consultingRecordIssue(record)) throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
}

/**
 * 「청구서로 전환」한 뒤의 납부 (PB-03). 문장은 단추(`payGate`)와 쓰기(`addPayment` 409)가 **같은 것**을 쓴다.
 * 전환 청구서는 남은 돈을 담고 있어서, 여기에 `cons_pay` 를 또 적으면 같은 돈이 두 원장에 선다.
 */
const CONS_PAY_INVOICED_MESSAGE = '청구서로 전환한 건입니다 — 입금은 회계 화면의 그 청구서에 기록하세요';

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

  /**
   * 컨설팅 비공개 스위치(N-94 · 회계 탭 줄 「컨설팅 비공개」) — 켜져 있으면 이 사람이 **줄 금액**을 보는가.
   * 건별 공개 범위(csCan · cons.share)는 그대로 먼저 보고, 이 판정은 그 위에 한 층을 더한다. 합계에는 쓰지 않는다.
   * 쓰기 판정(납부 넣기 · 청구서로 전환)은 건드리지 않는다 — 가리는 것은 읽기다.
   * 컨트롤러가 읽는 네 경로(목록 · 상세 · §27 · §28)에 넘긴다 — 비공개 열람(canHide)이면 표를 읽지 않는다.
   */
  async consultingLineShown(canHide: boolean): Promise<boolean> {
    if (canHide) return true;
    const privacy = await readAcctPrivacy({ query: (sql, p) => this.q(sql, p) });
    return lineAmountVisible(true, privacy.consulting.private, canHide);
  }

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
        message: '비공개로 지정하는 것은 대표만 할 수 있습니다',
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
              to_char(c.start_on,'YYYY-MM-DD') AS start_on_text,
              to_char(c.end_on,'YYYY-MM-DD') AS end_on_text,
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

  /**
   * 계약 핵심정보는 계약 작업이 시작되기 전(1단계)에만 바꾼다. 종류는 기본 항목 템플릿과 결합되어 있어 여기서 받지 않고,
   * 공개 범위도 기존 전용 경로가 소유한다. 학생 연결과 본체, 감사 원장은 한 트랜잭션이다.
   */
  async updateCore(
    viewerId: number, canMoney: boolean, canHide: boolean, consId: number, dto: ConsultingPatchDto,
  ): Promise<ConsultingDetailDto> {
    const fields = ['studentIds', 'requester', 'ownerId', 'amount', 'sessions', 'startOn', 'endOn'] as const;
    if (!fields.some((key) => dto[key] !== undefined)) {
      throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 값을 하나 이상 보내야 합니다' });
    }
    await this.anyRepo.manager.transaction(async (m) => {
      const locked = await this.lockFull(m, viewerId, canHide, consId);
      if (String(locked.stage) !== 'contract' || Number(locked.contract_step) !== 1) {
        throw new ConflictException({ code: 'CONS_CORE_LOCKED', message: '계약서 작업을 시작하기 전까지만 핵심정보를 바꿀 수 있습니다' });
      }
      const currentStudents = ((await m.query(
        `SELECT student_id FROM cons_stu WHERE cons_id=$1 ORDER BY student_id`, [consId],
      )) as Array<{ student_id: string }>).map((row) => Number(row.student_id));
      const nextStudents = dto.studentIds ?? currentStudents;
      if (dto.studentIds !== undefined) {
        const [{ count }] = (await m.query(
          `SELECT count(*)::int AS count FROM stu WHERE id=ANY($1::bigint[])`, [nextStudents],
        )) as Array<{ count: number }>;
        if (count !== nextStudents.length) {
          throw new BadRequestException({ code: 'CONS_STUDENT_INVALID', message: '존재하지 않는 학생이 포함되었습니다' });
        }
      }
      if (dto.ownerId !== undefined) await this.assertActiveAdminStaff(m, [dto.ownerId]);
      const startOn = dto.startOn ?? String(locked.start_on_text);
      const endOn = dto.endOn ?? String(locked.end_on_text);
      if (startOn > endOn) {
        throw new BadRequestException({ code: 'CONS_DATE_ORDER', message: '종료일은 시작일보다 빠를 수 없습니다' });
      }
      const picked = ((await m.query(
        `SELECT staff_id FROM cons_pick WHERE cons_id=$1 ORDER BY staff_id`, [consId],
      )) as Array<{ staff_id: string }>).map((row) => Number(row.staff_id));
      const ownerId = dto.ownerId ?? Number(locked.owner_id);
      this.assertNoSelfLockout(String(locked.share) as ConsShare, ownerId, picked, viewerId, canHide);
      const before = {
        studentIds: currentStudents, requester: locked.requester, ownerId: Number(locked.owner_id),
        amount: Number(locked.amount), sessions: Number(locked.sessions),
        startOn: String(locked.start_on_text), endOn: String(locked.end_on_text),
      };
      const after = {
        studentIds: nextStudents, requester: dto.requester ?? before.requester, ownerId,
        amount: dto.amount ?? before.amount, sessions: dto.sessions ?? before.sessions,
        startOn, endOn,
      };
      await m.query(
        `UPDATE cons SET requester=$2, owner_id=$3, amount=$4, sessions=$5, start_on=$6::date, end_on=$7::date WHERE id=$1`,
        [consId, after.requester, after.ownerId, after.amount, after.sessions, after.startOn, after.endOn],
      );
      if (dto.studentIds !== undefined) {
        await m.query(`DELETE FROM cons_stu WHERE cons_id=$1`, [consId]);
        await m.query(`INSERT INTO cons_stu (cons_id,student_id) SELECT $1,unnest($2::bigint[])`, [consId, nextStudents]);
      }
      await audit(m, 'consulting.core', { actorId: viewerId, entityId: consId, before, after });
    });
    return this.detail(viewerId, canMoney, canHide, consId);
  }

  /**
   * @param canApproveClose 예외 종료 승인 권한(`perm.canCeoApproveConsultingClose`) — 상세의 `canCloseException` 재료.
   *   진행 중인 건만 예외 종료가 되므로 계약 단계 건을 돌려주는 쓰기(만들기 · 공개 범위 · 전달)는 넘기지 않아도 답이 같다.
   */
  async detail(
    viewerId: number, canMoney: boolean, canHide: boolean, consId: number, canApproveClose = false, lineShown = true,
  ): Promise<ConsultingDetailDto> {
    return this.anyRepo.manager.transaction(async (m) => this.detailLocked(m, viewerId, canMoney, canHide, consId, canApproveClose, lineShown));
  }

  /**
   * 상세 응답은 공개 범위 판정부터 모든 자식 원장 조회까지 같은 트랜잭션에서 만든다.
   * `FOR SHARE`로 CONS 한 줄을 잡아 두어 share 변경/보관이 중간에 끼어 권한이 바뀐
   * 응답이나 `undefined` 접근 500을 만들지 않게 한다. 읽기끼리는 서로 막지 않는다.
   */
  private async detailLocked(
    m: EntityManager, viewerId: number, canMoney: boolean, canHide: boolean, consId: number, canApproveClose: boolean,
    lineShown = true,
  ): Promise<ConsultingDetailDto> {
    const q = <T = R>(sql: string, p: unknown[] = []): Promise<T[]> => m.query(sql, p) as Promise<T[]>;
    const { share, viewer } = await this.gate(m, viewerId, canHide, canMoney, consId);
    if (!csCanFull(share, viewer)) throw new ForbiddenException('이 건의 내용은 공개 범위 밖입니다');
    const [detail] = await q(
      `SELECT c.*,to_char(c.start_on,'YYYY-MM-DD') AS start_on_text,to_char(c.end_on,'YYYY-MM-DD') AS end_on_text,
              to_char(c.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS created_at_text,
              o.name AS owner_name,
              -- 받은 돈은 §28 · 전이와 같은 조각이다 — 전환 청구서 입금까지 (N-33 ②)
              ${consPaidSql('c')} AS paid,
              (SELECT count(*)::int FROM cons_pay p WHERE p.cons_id=c.id) AS pay_rows,
              (SELECT i.id FROM inv i WHERE i.cs_id=c.id AND i.state<>'void') AS inv_id
         FROM cons c LEFT JOIN staff o ON o.id=c.owner_id WHERE c.id=$1 AND c.deleted_at IS NULL`, [consId],
    );
    // 정상 경로에서는 SHARE lock 때문에 사라질 수 없지만, 오염/드라이버 경계도 500으로 새지 않게 한다.
    if (!detail) throw new NotFoundException('컨설팅 건을 찾을 수 없습니다');
    const students = await q(`SELECT s.id,s.name FROM cons_stu x JOIN stu s ON s.id=x.student_id WHERE x.cons_id=$1 ORDER BY s.name,s.id`, [consId]);
    const picked = await q(`SELECT s.id,s.name FROM cons_pick x JOIN staff s ON s.id=x.staff_id WHERE x.cons_id=$1 ORDER BY s.name,s.id`, [consId]);
    // §30 계약 파일만 — 항목 파일(item_id)은 §31 항목 줄에 선다 (N-63)
    const fileRows = await q(
      `SELECT ${CONS_FILE_COLS} ${CONS_FILE_FROM}
        WHERE cf.cons_id=$1 AND cf.item_id IS NULL ORDER BY cf.created_at,cf.file_id`, [consId],
    );
    const files = fileRows.map(consFileDto);
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
      `SELECT (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND ${consSessDoneSql('x', '$2')}) AS done,
              (SELECT count(*)::int FROM cons_sess x WHERE x.cons_id=$1 AND x.on_date > $2::date) AS planned,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id=$1 AND i.required AND NOT i.done) AS required_left`,
      [consId, today],
    );
    const [closedEvent] = await q(
      `SELECT to_char(e.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD"T"HH24:MI:SS')||'+09:00' AS at,s.name AS by_name
         FROM cons_event e LEFT JOIN staff s ON s.id=e.by_id
        WHERE e.cons_id=$1 AND e.event_type='closed' ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [consId],
    );
    // 예외 종료의 사유 — 감사 원장(LOG)의 그 줄에 있다. 칸을 새로 파지 않는다 (N-18-a · 같은 사실을 두 곳에 적지 않는다)
    const [closeException] = String(detail.stage) === 'done' ? await q(
      `SELECT l.after->>'reason' AS reason FROM log l
        WHERE l.entity=$2 AND l.entity_id=$1 AND l.action=$3 ORDER BY l.at DESC, l.id DESC LIMIT 1`,
      [consId, CLOSE_EXCEPTION_AUDIT.entity, CLOSE_EXCEPTION_AUDIT.action],
    ) : [];
    const step = detail.contract_step == null ? null : Number(detail.contract_step);
    const stage = String(detail.stage) as ConsultingRecord['stage'];
    const contractFiles = files.filter((f) => f['role'] !== 'signed');
    const signedFiles = files.filter((f) => f['role'] === 'signed');
    const unresolved = feedback.filter((f) => !f.resolved).length;
    const paid = Number(detail.paid);
    const amount = detail.amount == null ? null : Number(detail.amount);
    const due = amount == null ? null : amount - paid;
    const invId = detail.inv_id == null ? null : Number(detail.inv_id);
    const paymentShown = lineShown;
    const mutable = stage === 'contract';
    const consType = String(detail.cons_type);
    const knownType = consType as ConsultingType;
    const sessionsDone = Number(counts?.done ?? 0);
    const sessionsPlanned = Number(counts?.planned ?? 0);
    const requiredLeft = Number(counts?.required_left ?? 0);
    // 「잡아 둔 날짜」까지 같은 판정에 넣는다 — 이 인자가 빠져 있어 단추가 헛섰다 (S5)
    const closeInput = {
      stage, sessions: detail.sessions == null ? null : Number(detail.sessions), sessionsDone, requiredLeft, sessionsPlanned,
    };
    const closeIssue = consultingCloseIssue(closeInput);
    // 지우기 — 쓰기(archive)와 같은 판정 · 같은 문장 (PB-11). 회차는 잡아 둔 날짜까지 센다(done + planned = cons_sess 전부)
    const archiveIssue = consultingArchiveIssue({
      payments: Number(detail.pay_rows ?? 0), liveInvoice: invId !== null, sessions: sessionsDone + sessionsPlanned,
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
      shareLabel: consShareLabel(share),
      shareMeaning: consShareMeaning(share),
      contractSteps: CONSULTING_CONTRACT_STEPS.map((label, i) => ({ step: i + 1, label, sub: CONSULTING_CONTRACT_STEP_SUB[i] })),
      pickedStaffIds: picked.map((s) => Number(s.id)),
      pickedStaffNames: picked.map((s) => String(s.name)),
      createdAt: String(detail.created_at_text),
      /*
       * 「회차 기록」은 C95 부터 **시간표 회차(SER)를 실제로 만든다**(있으면 잇는다 · `ConsultingSessionService.addSessions`).
       * 여기만 「약정 회차만 저장합니다」라 적혀 있어 모든 상세에 사실과 다른 배너가 섰다 (30-02). 유형과 무관하다.
       */
      typeCapability: consType === 'admissions'
        ? {
          defaultItemsSupported: true, reason: null,
          scheduleCreationSupported: true, scheduleCreationReason: null,
        }
        : {
          // 9유형 기본 항목표는 아직 없다(N-18-a 보류) — 그동안은 원문 §31 「항목 수정」으로 담당이 채운다(DQ5 대안)
          defaultItemsSupported: false, reason: '이 유형의 기본 항목은 아직 정해지지 않았습니다 — 「항목 수정」으로 담당자가 직접 채웁니다',
          scheduleCreationSupported: true, scheduleCreationReason: null,
        },
      capabilities: {
        canEdit: mutable && step === 1,
        canChangeShare: mutable,
        // 범위를 바꾸는 것과 **비공개를 고르는 것**은 다른 층이다 — §76 대표 전용 (S4)
        canSetPrivate: canHide,
        canAddContractFile: mutable && (step === 1 || step === 2 || step === 4) && files.length < CONSULTING_FILE_MAX,
        canRemoveContractFile: mutable && (step === 1 || step === 2) && feedback.length === 0 && contractFiles.length > 0,
        canAddFeedback: mutable && step === 2 && contractFiles.length > 0,
        canResolveFeedback: mutable && step === 2 && unresolved > 0,
        canDeliver: mutable && step === 2 && contractFiles.length > 0 && unresolved === 0,
        canAddSignedFile: mutable && step === 4 && Boolean(delivery) && files.length < CONSULTING_FILE_MAX,
        // 상세도 같은 판정을 쓴다 — 전에는 레거시 행에서 **서버는 받는데 단추가 안 서는** 반대 방향 불일치였다 (S5)
        ...ConsultingService.payGate({
          canMoney, stage, contractStep: step, legacy: detail.start_on == null && detail.requester == null, due, invId,
        }),
        canCreateInvoice: canMoney && invId === null && this.invoiceable(step, due),
        canArchive: archiveIssue === null,
        archiveBlockedReason: archiveIssue?.message ?? null,
        // N-77 — 계약서를 보호자 메일에 붙여 보낸다(보호자 선택 발송 · DQ3). 「전달 완료 기록」은 시스템 밖 전달의 기록으로 남는다
        externalParentSendSupported: true,
        externalParentSendReason: null,
        canSendContract: mutable && (step === 2 || step === 4) && contractFiles.length > 0 && unresolved === 0,
        canAddSession: consultingSessionAddIssue(stage) === null,
        // 진행 탭이 잠긴 까닭을 말한다 — 단추가 없는 것과 왜 없는지는 다른 정보다(I-89 「진행이 잠겨 있다」 · S5 규약)
        addSessionBlockedReason: consultingSessionAddIssue(stage)?.message ?? null,
        canClose: closeIssue === null,
        closeBlockedReason: closeIssue?.message ?? null,
        // 예외 종료 — 건의 상태(항목·회차만 남음)와 승인 권한 둘 다 (N-18-a · DQ6)
        canCloseException: canApproveClose && consultingExceptionCloseIssue(closeInput) === null,
        canEditItems: stage !== 'done',
      },
      contractFiles,
      signedFiles,
      feedback,
      delivery: delivery ? { deliveredAt: String(delivery.at), deliveredByName: (delivery.by_name as string) ?? null } : null,
      // 컨설팅 비공개(N-94)면 받은 돈 · 남은 돈은 비공개 열람만 — 계약 금액 입력값(amount)은 편집 칸이라 그대로 둔다
      payment: {
        paid: canMoney && paymentShown ? paid : null, due: canMoney && paymentShown ? due : null,
        invoiceId: canMoney ? invId : null,
      },
      sessionsDone,
      sessionsPlanned,
      requiredLeft,
      closedAt: closedEvent ? String(closedEvent.at) : null,
      closedByName: closedEvent ? ((closedEvent.by_name as string) ?? null) : null,
      closeReason: (closeException?.reason as string) ?? null,
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
    const [f] = (await m.query(`SELECT ${CONS_FILE_COLS} ${CONS_FILE_FROM} WHERE f.id=$1`, [fileId])) as R[];
    return consFileDto(f);
  }

  /*
   * 계약 파일(§30)을 세는 자리는 전부 `item_id IS NULL` · 초안/수정본은 `role IN ('draft','revision')` 이다 —
   * 항목 파일(N-63 · role item)이 같은 표에 들어오면서 「서명본이 아닌 것 = 계약서」라는 옛 셈이 항목 파일까지 계약서로 셌다.
   */
  async addContractFile(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const step = c.contract_step == null ? null : Number(c.contract_step);
      if (String(c.stage) !== 'contract' || (step !== 1 && step !== 2 && step !== 4)) {
        throw new ConflictException({ code: 'CONS_FILE_LOCKED', message: '계약서 작성·피드백 단계에서만 계약 파일을 추가합니다' });
      }
      const [{ count }] = (await m.query(`SELECT count(*)::int AS count FROM cons_file WHERE cons_id=$1 AND item_id IS NULL`, [consId])) as Array<{ count: number }>;
      if (count >= CONSULTING_FILE_MAX) throw new ConflictException({ code: 'CONS_FILE_LIMIT', message: '계약 관련 파일은 최대 10개입니다' });
      const [{ drafts }] = (await m.query(`SELECT count(*)::int AS drafts FROM cons_file WHERE cons_id=$1 AND role IN ('draft','revision')`, [consId])) as Array<{ drafts: number }>;
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
      const [linked] = (await m.query(`SELECT file_id FROM cons_file WHERE cons_id=$1 AND file_id=$2 AND role IN ('draft','revision') FOR UPDATE`, [consId, fileId])) as R[];
      if (!linked) throw new NotFoundException('계약 파일을 찾을 수 없습니다');
      await m.query(`DELETE FROM cons_file WHERE file_id=$1`, [fileId]);
      await m.query(`DELETE FROM file WHERE id=$1`, [fileId]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_removed',$2,$3)`, [consId, fileId, viewerId]);
      const [{ left }] = (await m.query(`SELECT count(*)::int AS left FROM cons_file WHERE cons_id=$1 AND role IN ('draft','revision')`, [consId])) as Array<{ left: number }>;
      if (left === 0) await m.query(`UPDATE cons SET contract_step=1 WHERE id=$1`, [consId]);
    });
  }

  async addFeedback(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFeedbackCreateDto): Promise<ConsultingFeedbackDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract' || Number(c.contract_step) !== 2) {
        throw new ConflictException({ code: 'CONS_FEEDBACK_LOCKED', message: '계약서 피드백 단계가 아닙니다' });
      }
      const [{ files }] = (await m.query(`SELECT count(*)::int AS files FROM cons_file WHERE cons_id=$1 AND role IN ('draft','revision')`, [consId])) as Array<{ files: number }>;
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

  /**
   * 전달할 수 있는 계약인가 — 「전달 완료 기록」(deliver)과 「계약서 전달하기」(N-77 · 보호자 발송)가 **같은 문**을 지난다.
   * 계약 2단계(피드백) 또는 4단계(전달 뒤 다시 보냄) · 계약서 있음 · 풀리지 않은 피드백 없음. 잠긴 cons 줄(`c`)을 받는다.
   * @returns 지금 계약 단계
   */
  private async assertDeliverable(m: EntityManager, consId: number, c: R): Promise<number> {
    const step = Number(c.contract_step);
    if (String(c.stage) !== 'contract' || (step !== 2 && step !== 4)) {
      throw new ConflictException({ code: 'CONS_DELIVERY_LOCKED', message: '피드백 완료 뒤 계약서를 전달합니다' });
    }
    const [{ files, unresolved }] = (await m.query(
      `SELECT
         (SELECT count(*)::int FROM cons_file WHERE cons_id=$1 AND role IN ('draft','revision')) AS files,
         (SELECT count(*)::int FROM cons_feedback WHERE cons_id=$1 AND resolved_at IS NULL) AS unresolved`, [consId],
    )) as Array<{ files: number; unresolved: number }>;
    if (files === 0) throw new ConflictException({ code: 'CONS_CONTRACT_FILE_REQUIRED', message: '계약서를 먼저 올려야 합니다' });
    if (unresolved > 0) throw new ConflictException({ code: 'CONS_FEEDBACK_OPEN', message: '해결되지 않은 피드백이 있습니다' });
    return step;
  }

  async deliverContract(viewerId: number, canMoney: boolean, canHide: boolean, consId: number): Promise<ConsultingDetailDto> {
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const step = Number(c.contract_step);
      if (String(c.stage) !== 'contract' || (step !== 2 && step !== 4)) {
        throw new ConflictException({ code: 'CONS_DELIVERY_LOCKED', message: '피드백 완료 뒤 계약서를 전달합니다' });
      }
      if (step === 4) return; // 재시도는 현재 단계에서 멱등이다. 수정본을 올리면 다시 step 2가 된다.
      await this.assertDeliverable(m, consId, c);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'parent_delivered',$2)`, [consId, viewerId]);
      await m.query(`UPDATE cons SET contract_step=4 WHERE id=$1`, [consId]);
    });
    return this.detail(viewerId, canMoney, canHide, consId);
  }

  /**
   * 「계약서 전달하기」(N-77) — 보호자 선택 발송(`GuardiansService.send`)이 **보내기 전에** 부른다. 발송과 같은 트랜잭션이다.
   *
   * 붙일 파일은 **그 컨설팅의 계약서**(초안 · 수정본)만 — 서명본 · 항목 파일 · 남의 컨설팅 파일은 400.
   * 문은 `lockFull`(공개 범위 csCanFull) 하나다 — 비공개 계약의 파일을 열 수 없는 사람이 메일로 내보내지 못하게.
   * 받는 학생도 그 컨설팅의 학생이어야 한다(보호자는 학생에 매달려 있다). 개수 · 크기 상한은 메일 한 통 기준.
   * 서명 링크는 만들지 않는다 — 서명본은 스캔 등록 그대로다(원문 슬라이드 30).
   *
   * @returns 잠근 컨설팅 id 와 메일 첨부(본문 바이트 포함)
   */
  async deliveryAttachments(
    m: EntityManager, viewerId: number, canHide: boolean, studentId: number, fileIds: readonly number[],
  ): Promise<{ consId: number; attachments: SendAttachment[] }> {
    const rows = (await m.query(
      `SELECT cf.file_id, cf.cons_id, cf.role AS file_role, f.name, f.mime, f.bytes
         FROM cons_file cf JOIN file f ON f.id = cf.file_id WHERE cf.file_id = ANY($1::bigint[])`, [[...fileIds]],
    )) as Array<{ file_id: string; cons_id: string; file_role: string; name: string; mime: string; bytes: number }>;
    const consIds = new Set(rows.map((r) => Number(r.cons_id)));
    if (rows.length !== fileIds.length || consIds.size !== 1 || rows.some((r) => r.file_role !== 'draft' && r.file_role !== 'revision')) {
      throw new BadRequestException({ code: 'CONS_DELIVERY_FILE_INVALID', message: '한 컨설팅의 계약서 파일만 붙일 수 있습니다' });
    }
    const consId = [...consIds][0]!;
    // 존재를 숨기는 404 · 내용 잠김 403 — 파일 원문을 내보내기 전에 같은 문을 지난다
    const c = await this.lockFull(m, viewerId, canHide, consId);
    await this.assertDeliverable(m, consId, c);
    const [linked] = (await m.query(
      `SELECT 1 FROM cons_stu WHERE cons_id = $1 AND student_id = $2`, [consId, studentId],
    )) as unknown[];
    if (!linked) throw new BadRequestException({ code: 'CONS_DELIVERY_STUDENT_INVALID', message: '이 컨설팅의 학생 보호자에게만 계약서를 보낼 수 있습니다' });
    if (rows.length > CONS_DELIVERY_FILES_MAX) {
      throw new BadRequestException({ code: 'CONS_DELIVERY_TOO_MANY', message: `계약서는 한 번에 ${CONS_DELIVERY_FILES_MAX}개까지 붙일 수 있습니다` });
    }
    const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
    if (total > CONS_DELIVERY_BYTES_MAX) {
      throw new BadRequestException({
        code: 'CONS_DELIVERY_TOO_LARGE',
        message: `메일 한 통에 붙일 수 있는 파일은 모두 합쳐 ${CONS_DELIVERY_BYTES_MAX / 1_000_000}MB 까지입니다`,
      });
    }
    // 본문은 검사를 다 지난 뒤에만 읽는다 — 차례는 고른 차례 그대로
    const data = (await m.query(`SELECT id, data FROM file WHERE id = ANY($1::bigint[])`, [[...fileIds]])) as Array<{ id: string; data: Buffer }>;
    const byId = new Map(data.map((d) => [Number(d.id), d.data]));
    const meta = new Map(rows.map((r) => [Number(r.file_id), r]));
    return {
      consId,
      attachments: fileIds.map((id) => ({ filename: meta.get(id)!.name, content: byId.get(id)!, contentType: meta.get(id)!.mime })),
    };
  }

  /**
   * 계약서 메일이 **실제로 나갔을 때만** 부른다(N-77 「보낸 척하지 않는다」) — 전달 기록 한 줄 · 2단계면 4단계(서명)로.
   * 4단계에서 다시 보낸 것도 새 줄로 남긴다(누구에게 언제 다시 보냈는지 · CONS_EVENT 원장 규약).
   */
  async markContractSent(m: EntityManager, consId: number, viewerId: number): Promise<void> {
    await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'parent_delivered',$2)`, [consId, viewerId]);
    await m.query(`UPDATE cons SET contract_step=4 WHERE id=$1 AND stage='contract' AND contract_step=2`, [consId]);
  }

  async addSignedFile(viewerId: number, canHide: boolean, consId: number, dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) !== 'contract' || Number(c.contract_step) !== 4) {
        throw new ConflictException({ code: 'CONS_SIGNED_LOCKED', message: '학부모 전달 뒤 서명본을 등록합니다' });
      }
      const [{ count, deliveries }] = (await m.query(
        `SELECT (SELECT count(*)::int FROM cons_file WHERE cons_id=$1 AND item_id IS NULL) AS count,
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

  /**
   * 지우기(보관 · soft delete) — PB-11: **받은 돈 · 살아 있는 전환 청구서 · 회차 기록이 있으면 409**.
   * 전에는 단계 · 수납과 무관하게 늘 됐고(`canArchive: true` 고정), 돈과 일정이 남은 건이 목록과 §28 합계에서만 사라졌다.
   * 판정 · 문장은 상세의 `canArchive · archiveBlockedReason` 과 같은 함수다. 지운 것은 감사 원장에 남는다(N-73 · 삭제).
   */
  async archive(viewerId: number, canHide: boolean, consId: number): Promise<void> {
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const [facts] = (await m.query(
        `SELECT (SELECT count(*)::int FROM cons_pay WHERE cons_id=$1) AS payments,
                EXISTS (SELECT 1 FROM inv WHERE cs_id=$1 AND state<>'void') AS live_invoice,
                (SELECT count(*)::int FROM cons_sess WHERE cons_id=$1) AS sessions`, [consId],
      )) as Array<{ payments: number; live_invoice: boolean; sessions: number }>;
      const issue = consultingArchiveIssue({
        payments: Number(facts.payments), liveInvoice: facts.live_invoice === true, sessions: Number(facts.sessions),
      });
      if (issue) throw new ConflictException(issue);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,by_id) VALUES ($1,'archived',$2)`, [consId, viewerId]);
      await m.query(`UPDATE cons SET deleted_at=now(),deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL`, [consId, viewerId]);
      await audit(m, 'consulting.archive', {
        actorId: viewerId, entityId: consId,
        before: { stage: String(c.stage), contractStep: c.contract_step == null ? null : Number(c.contract_step), share: String(c.share) },
        after: { archived: true },
      });
    });
  }

  async all(viewerId: number, canMoney: boolean, canHide: boolean, lineShown = true): Promise<ConsultingListDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              c.requester,
              to_char(c.start_on,'YYYY-MM-DD')    AS start_on,
              to_char(c.end_on,'YYYY-MM-DD')      AS end_on,
              to_char(c.created_at,'YYYY-MM-DD')  AS created_at,
              o.name AS owner_name,
              -- §27 탭 머리 「학생 N명」(26-03) — 학생별 화면(students)과 같은 cons_stu 를 같은 csCan 판정 뒤에 센다
              COALESCE((SELECT array_agg(cs.student_id) FROM cons_stu cs WHERE cs.cons_id = c.id), '{}') AS student_ids,
              -- 원본 카드의 금액쌍 왼쪽 반 — §28 · 계약 → 진행 전이와 같은 조각(cons_pay + 전환 청구서 입금 · N-33 ②)
              ${consPaidSql('c')} AS paid_amount,
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
      `${CONS_SESS_SELECT} WHERE x.cons_id = ANY($1::bigint[]) ORDER BY x.cons_id, x.seq`,
      [fullIds],
    ) : [];
    const itemsByCons = await this.itemsOf(
      { query: (sql, p) => this.q(sql, p) },
      new Map(visible.filter(({ full }) => full).map(({ r }) => [Number(r.id), String(r.stage)])),
    );

    const byCons = new Map<number, ConsultingSessionDto[]>();
    const today = todayKst();
    for (const r of logs) {
      const k = Number(r.cons_id);
      if (!byCons.has(k)) byCons.set(k, []);
      byCons.get(k)!.push(consSessDto(r, today));
    }

    for (const sessions of byCons.values()) {
      if (consultingSessionIssue(sessions.map(({ seq }) => seq))) {
        throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
      }
    }

    const items = visible.map(({ r, share, full, money: moneyByShare }) => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: r.sessions };
      assertRecord(record);
      // 컨설팅 비공개(N-94)가 켜져 있으면 카드의 금액쌍도 비공개 열람만 본다
      const money = moneyByShare && lineShown;

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
        typeLabel: consultingTypeLabel(String(r.cons_type)),
        shareLabel: consShareLabel(share),
        // 카드 칩만 원본의 짧은 낱말 「수납만」(26-08)
        shareChipLabel: consShareChipLabel(share),
        contractStepLabel: consultingContractStepLabel(record.contractStep),
        requesterLabel: consultingRequesterLabel(r.requester as string | null),
        // 「N일 지남」 — 계약 시작일부터(시작 전 · 미정이면 null). 건이 생긴 날로 세면 새 건이 전부 「0일 지남」이었다 (26-10 · qa-w3)
        ageDays: consultingAgeDays((r.start_on as string) ?? null, today),
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
      // 공개 범위 넷의 이름과 뜻 — §29 칩 아래 한 줄(29-06)도 §30 배너와 같은 낱말이다 (D-R18)
      shares: CONS_SHARES.map((key) => ({ key, label: consShareLabel(key), meaning: consShareMeaning(key) ?? '' })),
      // §29 고르개 낱말 — 종류 10(가운뎃점 앞뒤 띄움 · 29-02) · 요청자 2. 화면은 이 차례·이름 그대로 칩을 세운다
      types: consultingTypeWords(),
      requesters: consultingRequesterWords(),
      // §27 탭 머리 「학생 N명」 — 탭을 열기 전에도 선다(26-03). 볼 수 있는 건의 학생만, 한 사람은 한 번 (students() 와 같은 셈)
      studentCount: new Set(visible.flatMap(({ r }) => ((r.student_ids as Array<string | number>) ?? []).map(Number))).size,
    };
  }

  /**
   * §31 항목 체크/해제 — 47D-B 의 유일한 쓰기. 공개 범위(csCanFull)와 종료 잠금은 서버가 판정한다.
   * 보이지 않는 건은 404(존재 누출 금지), 내용 잠김은 403, 종료 건은 409 ITEM_LOCKED.
   *
   * **해제가 지우개였다 — 이제 원장에 남는다** (S7 · 전수 검수 §7). 끄는 갈래는 `done_by`·`done_at` 을
   * NULL 로 되돌려 **누가 언제 끝냈다고 했는지가 행에서 통째로 사라지는데** 어느 원장에도 줄이 없었다.
   * 필수 항목은 컨설팅 종료를 막는 조건(`CONS_ITEMS_LEFT`)이라 그 체크는 업무 판단이고, 지워지면
   * 나중에 「왜 종료가 열렸나」를 되짚을 데가 없다.
   *
   * 남기는 자리는 이 파일의 다른 열한 쓰기와 **같은 원장**이다 — `cons_event` · `ref_id` 는 항목 id ·
   * 낱말 둘(`item_done`·`item_undone` · 마이그레이션 55). 켬과 끔을 한 낱말로 접으면 append-only 원장의
   * 마지막 줄이 지금 상태를 말하지 못한다. 한 자리만 `log` 로 보내지 않은 이유는 「이 건에 누가 무엇을
   * 했나」의 답이 두 표로 갈리기 때문이다.
   *
   * **같은 트랜잭션이다** — 밖에서 남기면 쓰기는 되돌아가고 줄만 남아 「하지도 않은 일」이 찍힌다.
   * 문은 `lockFull` 하나를 지난다(손으로 적고 있던 같은 판정을 지웠다 — 두 벌이면 한쪽만 낡는다).
   * 항목 행도 잠근다: 안 잠그면 두 사람이 같은 항목을 동시에 눌렀을 때 행의 상태와 원장의 마지막 줄이 갈린다.
   */
  async toggleItem(viewerId: number, canHide: boolean, consId: number, itemId: number, dto: ConsItemToggleDto): Promise<ConsItemDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) === 'done') {
        throw new ConflictException({ code: 'ITEM_LOCKED', message: '종료된 컨설팅의 항목은 바꿀 수 없습니다' });
      }
      const [exists] = (await m.query(
        `SELECT id FROM cons_item WHERE id = $1 AND cons_id = $2 FOR UPDATE`, [itemId, consId],
      )) as R[];
      if (!exists) throw new NotFoundException('항목을 찾을 수 없습니다');
      // UPDATE 의 RETURNING 은 드라이버가 [rows, count] 로 감싼다 — 갱신과 조회를 분리해 모양 의존을 없앤다
      await m.query(
        dto.done
          ? `UPDATE cons_item SET done = true, done_by = $3, done_at = now() WHERE id = $1 AND cons_id = $2`
          : `UPDATE cons_item SET done = false, done_by = NULL, done_at = NULL WHERE id = $1 AND cons_id = $2`,
        dto.done ? [itemId, consId, viewerId] : [itemId, consId],
      );
      await m.query(
        `INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,$2,$3,$4)`,
        [consId, dto.done ? 'item_done' : 'item_undone', itemId, viewerId],
      );
      const items = await this.itemsOf(m, new Map([[consId, String(c.stage)]]));
      return (items.get(consId) ?? []).find((i) => i.id === itemId)!;
    });
  }

  /**
   * 항목 줄 + 항목 파일(N-63)을 건마다 묶는다 — 목록 · 학생별 · 항목 쓰기 응답이 **같은 두 질의**를 쓴다 (D-R22).
   * 단추(`canAddFile · canRename · canRemove`)는 건의 단계와 파일 수로 서버가 판정한다(`consItemEditIssue`).
   * @param stages 내용이 열리는 건의 id → 단계. 여기 없는 건의 항목은 읽지 않는다(잠긴 건은 항목이 안 내려간다)
   */
  private async itemsOf(
    runner: { query(sql: string, params?: unknown[]): Promise<unknown> },
    stages: ReadonlyMap<number, string>,
  ): Promise<Map<number, ConsItemDto[]>> {
    const ids = [...stages.keys()];
    const out = new Map<number, ConsItemDto[]>();
    if (ids.length === 0) return out;
    const itemRows = (await runner.query(
      `${CONS_ITEM_SELECT} WHERE i.cons_id = ANY($1::bigint[]) ORDER BY i.cons_id, i.seq`, [ids],
    )) as R[];
    const fileRows = (await runner.query(
      `SELECT ${CONS_FILE_COLS} ${CONS_FILE_FROM}
        WHERE cf.cons_id = ANY($1::bigint[]) AND cf.item_id IS NOT NULL ORDER BY cf.created_at, cf.file_id`, [ids],
    )) as R[];
    const filesByItem = new Map<number, ConsultingFileDto[]>();
    for (const f of fileRows) {
      const k = Number(f.item_id);
      if (!filesByItem.has(k)) filesByItem.set(k, []);
      filesByItem.get(k)!.push(consFileDto(f));
    }
    for (const r of itemRows) {
      const k = Number(r.cons_id);
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(consItemDto(r, filesByItem.get(Number(r.id)) ?? [], stages.get(k)!));
    }
    return out;
  }

  /**
   * 원문 §31 「항목 수정」 — 더하기 · 이름 바꾸기 · 빼기 (N-18-a · DQ5 대안 「담당자가 계약마다 항목을 직접 구성」).
   *
   * - 문은 `lockFull`(공개 범위) 하나 · 종료된 건은 409 `ITEM_LOCKED`(체크와 같은 규약).
   * - 더한 항목은 `source='manual'` · 순번은 맨 뒤 · 필수 여부는 담당이 고른다(끝내야 종료가 열린다).
   * - 이름 바꾸기 · 빼기는 `consItemEditIssue` 가 막는다 — 끝낸 항목 · 기본 항목 빼기 · 파일이 붙은 항목 빼기.
   * - 같은 이름 둘 · 서른 개 넘김은 막는다. 한 요청 안에서 같은 항목을 두 번 적어도 막는다.
   * - 흔적 둘: 건의 활동 원장(`cons_event` item_added · item_renamed · item_removed — 체크와 같은 원장)과
   *   감사 원장(`log` · 앞뒤 목록 — N-73 삭제). **같은 트랜잭션**이다.
   *
   * 9유형 기본 항목표는 넣지 않는다 — 대표 · 운영만 아는 체크리스트라 보류 그대로다(N-18-a blockedReason).
   * @returns 바뀐 뒤의 항목 전부(순번 차례)
   */
  async editItems(viewerId: number, canHide: boolean, consId: number, dto: ConsItemsEditDto): Promise<ConsItemDto[]> {
    const add = dto.add ?? [];
    const rename = dto.rename ?? [];
    const remove = dto.remove ?? [];
    if (add.length + rename.length + remove.length === 0) {
      throw new ConflictException({ code: 'EMPTY_PATCH', message: '바꿀 항목이 없습니다' });
    }
    const touched = [...rename.map((x) => x.id), ...remove];
    if (new Set(touched).size !== touched.length) {
      throw new BadRequestException({ code: 'CONS_ITEM_OP_DUPLICATE', message: '한 항목을 한 번에 두 번 바꿀 수 없습니다' });
    }
    const label = (raw: string): string => {
      const t = raw.trim();
      if (!t) throw new BadRequestException({ code: 'CONS_ITEM_LABEL_REQUIRED', message: '항목 이름을 적어 주세요' });
      return t;
    };
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const stage = String(c.stage);
      if (stage === 'done') throw new ConflictException({ code: 'ITEM_LOCKED', message: '종료된 컨설팅의 항목은 바꿀 수 없습니다' });
      const beforeRows = (await m.query(
        `SELECT i.id, i.seq, i.label, i.required, i.done, i.source,
                (SELECT count(*)::int FROM cons_file cf WHERE cf.item_id = i.id) AS files
           FROM cons_item i WHERE i.cons_id = $1 ORDER BY i.seq FOR UPDATE OF i`, [consId],
      )) as Array<{ id: string; seq: number; label: string; required: boolean; done: boolean; source: string; files: number }>;
      const byId = new Map(beforeRows.map((r) => [Number(r.id), r]));
      const snapshot = (rows: typeof beforeRows) => rows.map((r) => ({
        id: Number(r.id), seq: Number(r.seq), label: r.label, required: r.required, done: r.done, source: r.source,
      }));

      // 판정 먼저 — 한 줄이라도 막히면 아무것도 쓰지 않는다
      for (const id of touched) {
        if (!byId.has(id)) throw new NotFoundException({ code: 'CONS_ITEM_NOT_FOUND', message: '항목을 찾을 수 없습니다' });
      }
      const facts = (id: number) => {
        const r = byId.get(id)!;
        return { stage, done: r.done, source: r.source, files: Number(r.files) };
      };
      for (const x of rename) {
        const issue = consItemEditIssue('rename', facts(x.id));
        if (issue) throw new ConflictException(issue);
      }
      for (const id of remove) {
        const issue = consItemEditIssue('remove', facts(id));
        if (issue) throw new ConflictException(issue);
      }
      const renamed = new Map(rename.map((x) => [x.id, label(x.label)]));
      const added = add.map((x) => ({ label: label(x.label), required: x.required === true }));
      const finalLabels = [
        ...beforeRows.filter((r) => !remove.includes(Number(r.id))).map((r) => renamed.get(Number(r.id)) ?? r.label),
        ...added.map((x) => x.label),
      ];
      if (finalLabels.length > CONS_ITEM_MAX) {
        throw new ConflictException({ code: 'CONS_ITEM_LIMIT', message: `항목은 ${CONS_ITEM_MAX}개까지입니다` });
      }
      if (new Set(finalLabels).size !== finalLabels.length) {
        throw new BadRequestException({ code: 'CONS_ITEM_DUPLICATE', message: '같은 이름의 항목이 이미 있습니다' });
      }

      for (const id of remove) {
        await m.query(`DELETE FROM cons_item WHERE id = $1 AND cons_id = $2`, [id, consId]);
        await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'item_removed',$2,$3)`, [consId, id, viewerId]);
      }
      for (const [id, text] of renamed) {
        if (text === byId.get(id)!.label) continue; // 같은 이름이면 바꾼 것이 아니다 — 원장에 줄을 세우지 않는다
        await m.query(`UPDATE cons_item SET label = $3 WHERE id = $1 AND cons_id = $2`, [id, consId, text]);
        await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'item_renamed',$2,$3)`, [consId, id, viewerId]);
      }
      let seq = beforeRows.reduce((n, r) => Math.max(n, Number(r.seq)), 0);
      for (const x of added) {
        seq += 1;
        const [row] = (await m.query(
          `INSERT INTO cons_item (cons_id,seq,label,required,done,source) VALUES ($1,$2,$3,$4,false,'manual') RETURNING id`,
          [consId, seq, x.label, x.required],
        )) as Array<{ id: string }>;
        await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'item_added',$2,$3)`, [consId, row.id, viewerId]);
      }

      const afterRows = (await m.query(
        `SELECT i.id, i.seq, i.label, i.required, i.done, i.source, 0 AS files FROM cons_item i WHERE i.cons_id = $1 ORDER BY i.seq`, [consId],
      )) as typeof beforeRows;
      await audit(m, 'consulting.items', {
        actorId: viewerId, entityId: consId, before: { items: snapshot(beforeRows) }, after: { items: snapshot(afterRows) },
      });
      return (await this.itemsOf(m, new Map([[consId, stage]]))).get(consId) ?? [];
    });
  }

  /**
   * 항목 「파일」 올리기 — N-63 채택 ① `cons_file.item_id` · **같은 업로드**(`storeFile` · kind `cons-item`) · **같은 권한 함수**(`lockFull` → csCanFull).
   * 항목마다 6개 · 계약 파일 10개와 따로 센다(DB 트리거가 마지막에 막는다). 종료된 건은 409.
   */
  async addItemFile(viewerId: number, canHide: boolean, consId: number, itemId: number, dto: ConsultingFileCreateDto): Promise<ConsultingFileDto> {
    return this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      const [item] = (await m.query(
        `SELECT i.id, i.done, i.source, (SELECT count(*)::int FROM cons_file cf WHERE cf.item_id = i.id) AS files
           FROM cons_item i WHERE i.id = $1 AND i.cons_id = $2 FOR UPDATE OF i`, [itemId, consId],
      )) as Array<{ id: string; done: boolean; source: string; files: number }>;
      if (!item) throw new NotFoundException({ code: 'CONS_ITEM_NOT_FOUND', message: '항목을 찾을 수 없습니다' });
      const issue = consItemEditIssue('file', { stage: String(c.stage), done: item.done, source: item.source, files: Number(item.files) });
      if (issue) throw new ConflictException(issue);
      const file = await storeFile(m, viewerId, { kind: 'cons-item', name: dto.name, base64: dto.base64 });
      await m.query(
        `INSERT INTO cons_file (file_id,cons_id,role,created_by,item_id) VALUES ($1,$2,'item',$3,$4)`, [file.id, consId, viewerId, itemId],
      );
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_added',$2,$3)`, [consId, file.id, viewerId]);
      return this.readFile(m, file.id);
    });
  }

  /** 항목 파일 빼기 — 종료 전 건만. 파일 본문까지 지운다(계약 파일 빼기와 같은 모양) · 지운 것은 감사 원장에 남는다(N-73 삭제) */
  async removeItemFile(viewerId: number, canHide: boolean, consId: number, itemId: number, fileId: number): Promise<void> {
    await this.anyRepo.manager.transaction(async (m) => {
      const c = await this.lockFull(m, viewerId, canHide, consId);
      if (String(c.stage) === 'done') throw new ConflictException({ code: 'ITEM_LOCKED', message: '종료된 컨설팅의 항목은 바꿀 수 없습니다' });
      const [linked] = (await m.query(
        `SELECT cf.file_id, f.name, f.bytes FROM cons_file cf JOIN file f ON f.id = cf.file_id
          WHERE cf.cons_id = $1 AND cf.item_id = $2 AND cf.file_id = $3 FOR UPDATE OF cf`, [consId, itemId, fileId],
      )) as Array<{ file_id: string; name: string; bytes: number }>;
      if (!linked) throw new NotFoundException({ code: 'CONS_ITEM_FILE_NOT_FOUND', message: '항목 파일을 찾을 수 없습니다' });
      await m.query(`DELETE FROM cons_file WHERE file_id=$1`, [fileId]);
      await m.query(`DELETE FROM file WHERE id=$1`, [fileId]);
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'file_removed',$2,$3)`, [consId, fileId, viewerId]);
      await audit(m, 'consulting.item_file', {
        actorId: viewerId, entityId: consId,
        before: { itemId, fileId, name: linked.name, bytes: Number(linked.bytes) },
      });
    });
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
  async accounting(viewerId: number, canMoney: boolean, canHide: boolean, lineShown = true): Promise<ConsAccountingDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.share, c.owner_id,
              -- 「납부 넣기」 판정의 재료 — 서버가 보는 것과 같은 칸이어야 한다 (S5)
              (c.start_on IS NULL AND c.requester IS NULL) AS legacy,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              COALESCE((SELECT array_agg(s.name ORDER BY s.name)
                          FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                         WHERE cs.cons_id = c.id), '{}') AS student_names,
              -- 「청구서로 전환」 창의 받는 학생 고르개 (N-33 ②) — 이름 차례 · 위 이름 배열과 같은 차례
              COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name, s.id)
                          FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                         WHERE cs.cons_id = c.id), '[]'::json) AS students,
              -- 받은 돈 = cons_pay + 살아 있는 전환 청구서 입금 — 계약 → 진행 전이와 **같은 조각** (N-33 ② · 7-3 「§28 이 전환 청구서 입금을 모름」)
              ${consPaidSql('c')} AS paid,
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
    // 컨설팅 비공개(N-94 · `lineShown`) — 줄 금액만 가린다. 머리 세 칸(합계)은 가리지 않은 값에서 낸다
    const items: ConsAccountRowDto[] = visible.map(({ r, money: moneyByShare }) => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: null };
      assertRecord(record);
      const amount = r.amount === null || r.amount === undefined ? null : Number(r.amount);
      const paid = Number(r.paid);
      const due = amount === null ? null : amount - paid;
      if (moneyByShare && amount !== null) { totalAmount += amount; totalPaid += paid; totalDue += due!; }
      const money = moneyByShare && lineShown;
      const invId = r.inv_id === null || r.inv_id === undefined ? null : Number(r.inv_id);
      const stage = record.stage;
      return {
        id: Number(r.id),
        // 학생 이름은 이미 목록이 쓰는 배열 그대로다 — 여럿이면 원문 표의 한 칸에 쉼표로 든다
        studentName: ((r.student_names as string[]) ?? []).join(', '),
        students: ((r.students as Array<{ id: number | string; name: string }>) ?? []).map((s) => ({ id: Number(s.id), name: String(s.name) })),
        consType: String(r.cons_type),
        typeLabel: consultingTypeLabel(String(r.cons_type)),
        stage,
        stageLabel: consultingStageLabel(stage),
        amount: money ? amount : null,
        paid: money ? paid : null,
        due: money ? due : null,
        // 금액이 가려지면 납부 기록도 내려보내지 않는다 — 줄을 세면 금액이 드러난다
        payments: money ? (paysByCons.get(Number(r.id)) ?? []) : [],
        invId,
        // 쓰기 판정은 가림과 무관하다 — 건별 공개 범위 · 금액 권한 그대로 (N-94 는 읽기만 가린다)
        canInvoice: moneyByShare && invId === null && this.invoiceable(record.contractStep, due),
        ...ConsultingService.payGate({
          canMoney: moneyByShare, stage, contractStep: record.contractStep, legacy: r.legacy === true, due, invId,
        }),
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
   * 「납부 넣기」가 서는가 — **`addPayment` 가 실제로 거절하는 순서 그대로**다 (S5 · D-R39 · D-R22).
   *
   * 전에는 세 곳이 서로 다른 질문을 했다: 회계 표의 단추는 `amount`·`due`·`stage` 만 보고(계약 단계를
   * 안 봐서 **409 `CONS_PAY_NOT_READY`**), 상세의 `canAddPayment` 는 `step === 5` 를 **무조건** 걸어
   * (레거시 행은 서버가 받는데 단추가 안 서는 **반대 방향** 불일치), 서버만 「C79 신규 계약이면 step 5」
   * 였다. 이제 셋이 이 함수 하나를 본다.
   *
   * `legacy` — C79 이전 행(`start_on`·`requester` 가 둘 다 비어 있다). 그 행들에는 계약 5단계가 없어서
   * 단계를 요구하면 **기존 회계 계약이 깨진다**(서버가 그래서 예외를 두었다).
   *
   * `invId` — 살아 있는(취소 아닌) 전환 청구서. 있으면 납부는 그 청구서로 받는다 (PB-03).
   */
  private static payGate(input: {
    canMoney: boolean; stage: string; contractStep: number | null; legacy: boolean; due: number | null; invId: number | null;
  }): { canAddPayment: boolean; payBlockedReason: string | null } {
    const blocked = (reason: string) => ({ canAddPayment: false, payBlockedReason: reason });
    // 금액이 안 보이면 단추도 없다 — 이유를 적으면 그 자체가 금액 권한을 말한다
    if (!input.canMoney) return { canAddPayment: false, payBlockedReason: null };
    if (input.stage === 'done') return blocked('종료된 컨설팅에는 납부를 더할 수 없습니다');
    if (!input.legacy && input.contractStep !== CONTRACT_STEP_MAX) return blocked('서명본 등록 뒤 수납할 수 있습니다');
    if (input.invId !== null) return blocked(CONS_PAY_INVOICED_MESSAGE);
    // 문장은 쓰기의 409 `OVERPAY` 와 **같은 함수**에서 나온다 (S5 · D-R22)
    if (input.due !== null && input.due <= 0) return blocked(consultingRemainingMessage(input.due));
    return { canAddPayment: true, payBlockedReason: null };
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
   * 계약 → 진행 자동 전이 (N-18) — **다 받았을 때만**. 판정은 여기 한 곳이다 (PB-03).
   *
   * 받은 돈 = `cons_pay` 누계 + **살아 있는 전환 청구서에 붙은 입금**(`pay`). 전에는 `cons_pay` 만 봐서
   * 학부모가 전환 청구서로 전액을 내면 건이 영영 `contract` 에 머물고 회차 잡기(`CONS_NOT_RUNNING`)가 막혔다.
   * 두 원장은 같은 돈을 담지 않는다 — 전환은 남은 돈으로만 내고, 전환 뒤에는 `cons_pay` 를 막는다.
   *
   * 부르는 곳 둘: `addPayment`(cons_pay) · `AccountingService.addPayment`(cs 청구서 입금).
   * 조건을 `UPDATE … WHERE` 에 넣어 두 쓰기가 엇갈려도 한 번만, 조건이 참일 때만 넘어간다.
   * 받은 돈은 `consPaidSql` 한 조각이다 — §28 회계 · §26 · §27 · §30 이 같은 조각을 읽는다 (N-33 ②).
   *
   * **실제로 한 줄이 넘어갔을 때만**(RETURNING) 담당에게 알림 두 건 — 「수납 · 진행 가능」 · 「회차 기록 요청」
   * (N-65 채택 · 테스트 시나리오 I-90+ 의 두 줄). 같은 트랜잭션이다 — 쓰기가 되돌아가면 알림도 없다.
   * 받는 사람은 회차를 잡고 기록하는 **담당**이다. 수납을 넣은 사람이 곧 담당이면 되알리지 않는다(스스로 한 일).
   * 담당이 없거나 사용 중지면 보내지 않는다. 할 일은 만들지 않는다 — 회차를 잡으면 C95 가 회차마다 할 일을 만든다(두 줄이 되지 않게).
   * 링크는 그 컨설팅 상세(`/consulting?id=`)다.
   *
   * @param actorId 수납을 넣은 사람 — 담당과 같으면 알림을 보내지 않는다
   * @returns 이번에 진행으로 넘어갔는가
   */
  static async promoteWhenPaid(
    m: { query(sql: string, params?: unknown[]): Promise<unknown> }, consId: number, actorId: number | null = null,
  ): Promise<boolean> {
    const [moved] = writtenRows<{ id: string; owner_id: string | null; cons_type: string }>(await m.query(
      `UPDATE cons c SET stage = 'running'
        WHERE c.id = $1 AND c.stage = 'contract' AND c.contract_step = $2 AND c.amount IS NOT NULL
          AND ${consPaidSql('c')} >= c.amount
        RETURNING c.id, c.owner_id, c.cons_type`,
      [consId, CONTRACT_STEP_MAX],
    ));
    if (!moved) return false;
    const ownerId = moved.owner_id == null ? null : Number(moved.owner_id);
    if (ownerId !== null && ownerId !== actorId) {
      const [{ names }] = (await m.query(
        `SELECT COALESCE(string_agg(s.name, ' · ' ORDER BY s.name, s.id), '') AS names
           FROM cons_stu x JOIN stu s ON s.id = x.student_id WHERE x.cons_id = $1`, [consId],
      )) as Array<{ names: string }>;
      const who = `${names || '학생 미정'} · ${consultingTypeLabel(moved.cons_type)}`;
      await m.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT st.id, $2::bigint, v.body, $3::text, 'etc', v.title
           FROM staff st, (VALUES (1, $4::text, $5::text), (2, $6::text, $7::text)) AS v(n, title, body)
          WHERE st.id = $1::bigint AND st.active
          ORDER BY v.n`,
        [
          ownerId, actorId, `/consulting?id=${consId}`,
          NOTI_TITLE.consPaid, `${who} — 계약 금액을 다 받아 진행 단계로 넘어갔습니다`,
          NOTI_TITLE.consRecordRequest, `${who} — 회차 날짜를 잡고 기록해 주세요`,
        ],
      );
    }
    return true;
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
      // 안건 N-132 — 같은 요청 키는 한 줄. 잠금 차례: 권고 잠금 → 컨설팅 행(청구서 입금과 같다 · lib/pay-request-key)
      await lockPayRequestKey(m, dto.requestKey);
      const { row: locked, share, viewer } = await this.lockVisible(m, viewerId, canHide, canMoney, consId);
      if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');
      // 보이는지 · 금액을 볼 수 있는지를 먼저 본 뒤에 판정한다 — 앞선 줄이 있다는 사실도 공개 범위 안의 일이다
      const prior = await priorConsPayForKey(m, dto.requestKey, { consId, amount: dto.amount, paidOn: dto.paidOn, memo: dto.memo });
      if (prior != null) return; // 앞선 요청이 이미 넣었다 — 줄을 더하지 않고 그 건의 지금 모습을 돌려준다
      if (String(locked.stage) === 'done') {
        throw new ConflictException({ code: 'CONS_PAY_LOCKED', message: '종료된 컨설팅에는 납부를 더할 수 없습니다' });
      }
      // C79 신규 계약은 서명본(step 5) 전 수납을 막는다. 레거시 행은 기존 회계 계약을 보존한다.
      // 문장은 `payGate` 와 같다 — 단추가 미리 말하는 이유와 눌렀을 때의 이유가 갈리면 안 된다 (S5)
      const c79 = locked.start_on != null || locked.requester != null;
      if (c79 && Number(locked.contract_step) !== CONTRACT_STEP_MAX) {
        throw new ConflictException({ code: 'CONS_PAY_NOT_READY', message: '서명본 등록 뒤 수납할 수 있습니다' });
      }
      // 전환 청구서가 살아 있으면 돈은 그 청구서로 받는다 — 여기 또 적으면 같은 돈이 두 원장에 선다 (PB-03)
      // `toInvoice` 도 같은 cons 행을 FOR UPDATE 로 잡으므로 둘이 엇갈려 끼어들지 않는다
      const [live] = (await m.query(
        `SELECT id FROM inv WHERE cs_id = $1 AND state <> 'void' LIMIT 1`, [consId],
      )) as Array<{ id: string }>;
      if (live) throw new ConflictException({ code: 'CONS_PAY_INVOICED', message: CONS_PAY_INVOICED_MESSAGE });
      const amount = locked.amount == null ? null : Number(locked.amount);
      const [{ paid: paidBefore }] = (await m.query(
        `SELECT COALESCE(sum(amount),0)::int AS paid FROM cons_pay WHERE cons_id=$1`, [consId],
      )) as Array<{ paid: number }>;
      const before = Number(paidBefore);
      if (amount !== null && before + dto.amount > amount) {
        throw new ConflictException({
          code: 'OVERPAY',
          message: consultingRemainingMessage(amount - before),
        });
      }
      const [pay] = (await m.query(
        `INSERT INTO cons_pay (cons_id,amount,paid_on,memo,by_id,request_key) VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING id`,
        [consId, dto.amount, dto.paidOn, dto.memo?.trim() || null, viewerId, dto.requestKey],
      )) as Array<{ id: string }>;
      await m.query(`INSERT INTO cons_event (cons_id,event_type,ref_id,by_id) VALUES ($1,'payment_added',$2,$3)`, [consId, pay.id, viewerId]);
      await ConsultingService.promoteWhenPaid(m, consId, viewerId);
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
   * **받는 학생은 사람이 고른다** (N-33 ② ①) — `inv.student_id` 는 한 명이다. 학생이 여럿인 컨설팅은 `studentId` 가 필수이고
   * (없으면 전처럼 409 `CONS_INV_STUDENT_AMBIGUOUS` — 이제 그 자리가 창의 입력 한 칸이다), 한 명이면 비워도 그 학생이다.
   * 고른 학생은 그 컨설팅의 학생이어야 한다(400). 서버가 대신 고르지 않는다(추정 없음 · N-25).
   * 전환은 감사 원장에 남는다(N-73 `consulting.to_invoice` — 돈).
   * **마감한 달에는 내지 않는다**(W11 A′ 후속 · M1 발견) — 전환 청구서의 달(오늘 KST 의 달)을 발행 · 이월과 같은 축에서 본다.
   */
  async toInvoice(viewerId: number, canMoney: boolean, canHide: boolean, consId: number, dto: ConsToInvoiceDto = {}): Promise<ConsAccountRowDto> {
    await this.anyRepo.manager.transaction(async (m: EntityManager) => {
      // 같은 건을 두 번 눌러도 청구서는 하나다 — 잠그고 다시 센다 (inv_cs_id_live_uniq 가 최후 방어)
      const { row: c, share, viewer } = await this.lockVisible(m, viewerId, canHide, canMoney, consId);
      if (!csCanAmount(share, viewer)) throw new ForbiddenException('이 건의 금액은 공개 범위 밖입니다');
      // 전환 청구서의 달 = 오늘(KST)의 달. 마감한 달이면 409 MONTH_CLOSED(발행 · 이월과 같은 문장) —
      // 달 열쇠를 공유로 잡은 **뒤** 마감을 읽으므로 이 전환이 끝나기 전에는 그 달의 마감이 커밋되지 않는다
      const today = todayKst();
      const [ym, mm] = today.split('-');
      await assertMonthOpenForWrite(m, `${ym}-${mm}`);
      const [{ live }] = (await m.query(
        `SELECT count(*)::int AS live FROM inv WHERE cs_id = $1 AND state <> 'void'`, [consId],
      )) as Array<{ live: number }>;
      if (live > 0) {
        throw new ConflictException({ code: 'CONS_INV_EXISTS', message: '이미 이 컨설팅의 청구서가 있습니다' });
      }
      // 받은 돈은 §28 · 전이와 같은 조각이다 — 살아 있는 전환 청구서가 없으니 여기서는 cons_pay 누계와 같다 (N-33 ②)
      const [{ paid }] = (await m.query(
        `SELECT ${consPaidSql('c')}::bigint AS paid FROM cons c WHERE c.id = $1`, [consId],
      )) as Array<{ paid: string | number }>;
      const amount = c.amount === null || c.amount === undefined ? null : Number(c.amount);
      const step = c.contract_step === null || c.contract_step === undefined ? null : Number(c.contract_step);
      const due = amount === null ? null : amount - Number(paid);
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
      const students = ((await m.query(
        `SELECT student_id FROM cons_stu WHERE cons_id = $1 ORDER BY student_id`, [consId],
      )) as Array<{ student_id: string }>).map((s) => Number(s.student_id));
      if (students.length === 0) {
        throw new ConflictException({
          code: 'CONS_INV_STUDENT_AMBIGUOUS',
          message: '학생이 연결되지 않은 컨설팅입니다 — 청구서를 누구 앞으로 낼지 정할 수 없습니다',
        });
      }
      let studentId: number;
      if (dto.studentId !== undefined && dto.studentId !== null) {
        if (!students.includes(dto.studentId)) {
          throw new BadRequestException({ code: 'CONS_INV_STUDENT_INVALID', message: '이 컨설팅의 학생 앞으로만 청구서를 낼 수 있습니다' });
        }
        studentId = dto.studentId;
      } else if (students.length === 1) {
        studentId = students[0]!;
      } else {
        throw new ConflictException({
          code: 'CONS_INV_STUDENT_AMBIGUOUS',
          message: '학생이 둘 이상인 컨설팅입니다 — 청구서를 받을 학생을 고르세요',
        });
      }
      const title = `${ym}년 ${Number(mm)}월 ${INV_TYPE_LABEL.consulting}`;
      const [inv] = (await m.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state, issued_on, created_by, cs_id)
         VALUES ($1, $2, 'consulting', $3, $4, 'draft', $5::date, $6, $7) RETURNING id`,
        [studentId, `${ym}-${mm}`, title, due, today, viewerId, consId],
      )) as Array<{ id: string }>;
      // N-73 — 돈의 쓰기는 같은 트랜잭션에서 감사 원장에 한 줄
      await audit(m, 'consulting.to_invoice', {
        actorId: viewerId, entityId: consId,
        after: { invId: Number(inv.id), studentId, amount: due, yearMonth: `${ym}-${mm}`, title },
      });
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
  async students(viewerId: number, canMoney: boolean, canHide: boolean, lineShown = true): Promise<ConsStudentsDto> {
    const today = todayKst();
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              to_char(c.start_on,'YYYY-MM-DD')   AS start_on,
              to_char(c.end_on,'YYYY-MM-DD')     AS end_on,
              to_char(c.created_at,'YYYY-MM-DD') AS created_on,
              o.name AS owner_name,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              (SELECT count(*)::int FROM cons_sess s WHERE s.cons_id = c.id)                 AS sessions_logged,
              -- 「회차 2 / 6」은 §26 카드 · §30 머리와 같은 셈이다 — 앞으로 잡아 둔 날짜는 세지 않는다 (27-04)
              (SELECT count(*)::int FROM cons_sess s WHERE s.cons_id = c.id AND ${consSessDoneSql('s', '$2')}) AS sessions_done,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id = c.id)                 AS items_total,
              (SELECT count(*)::int FROM cons_item i WHERE i.cons_id = c.id AND i.done)      AS items_done,
              -- 받은 돈 — §28 · 계약 → 진행 전이와 같은 조각(전환 청구서 입금 포함 · N-33 ②)
              ${consPaidSql('c')} AS paid
         FROM cons c LEFT JOIN staff o ON o.id = c.owner_id
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC, c.id`,
      [viewerId, today],
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
    const linkRows = await this.q(
      `SELECT cs.cons_id, s.id AS student_id, s.name, s.grade
         FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
        WHERE cs.cons_id = ANY($1::bigint[])
        ORDER BY s.name, s.id`,
      [ids],
    );
    const itemsByCons = await this.itemsOf(
      { query: (sql, p) => this.q(sql, p) },
      new Map(visible.filter(({ full }) => full).map(({ r }) => [Number(r.id), String(r.stage)])),
    );

    const caseOf = (r: R, money: boolean, full: boolean): ConsStudentCaseDto => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: r.sessions };
      assertRecord(record);
      return {
        id: Number(r.id),
        consType: String(r.cons_type),
        typeLabel: consultingTypeLabel(String(r.cons_type)),
        stage: record.stage,
        stageLabel: consultingStageLabel(record.stage),
        createdOn: String(r.created_on),
        startOn: (r.start_on as string) ?? null,
        endOn: (r.end_on as string) ?? null,
        ownerName: (r.owner_name as string) ?? null,
        sessionsLogged: Number(r.sessions_logged),
        sessionsDone: Number(r.sessions_done),
        sessions: record.sessions,
        itemsDone: Number(r.items_done),
        itemsTotal: Number(r.items_total),
        amount: money && r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
        paid: money ? Number(r.paid) : null,
        items: full ? (itemsByCons.get(Number(r.id)) ?? []) : [],
      };
    };

    const byCons = new Map(visible.map((v) => [Number(v.r.id), v]));
    // 컨설팅 비공개(N-94 · `lineShown`) — 켜져 있으면 건 · 학생 줄의 금액을 비공개 열람만 본다(학생 줄 합도 줄이다)
    const students = new Map<number, ConsStudentDto>();
    for (const l of linkRows) {
      const v = byCons.get(Number(l.cons_id));
      if (!v) continue; // 안 보이는 건은 학생 줄에도 안 걸린다
      const sid = Number(l.student_id);
      if (!students.has(sid)) {
        students.set(sid, {
          studentId: sid, name: String(l.name), grade: (l.grade as string) ?? null,
          caseCount: 0, amount: canMoney && lineShown ? 0 : null, paid: canMoney && lineShown ? 0 : null, cases: [],
        });
      }
      const s = students.get(sid)!;
      const c = caseOf(v.r, v.money && lineShown, v.full);
      s.cases.push(c);
      s.caseCount += 1;
      // 금액이 가려진 건은 학생 합계에도 안 들어간다 — 합계로 가려진 금액이 드러나면 안 된다
      if (canMoney && lineShown && v.money) {
        s.amount = (s.amount ?? 0) + (c.amount ?? 0);
        s.paid = (s.paid ?? 0) + (c.paid ?? 0);
      }
    }

    // 이름 순 — 왼쪽 줄의 차례다. 원문 컷도 이름으로 서 있다.
    const items = [...students.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return { items, canSeeAmounts: canMoney };
  }
}
