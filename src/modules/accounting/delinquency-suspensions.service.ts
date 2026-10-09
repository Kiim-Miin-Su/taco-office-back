/** @file-guide
 * 목적: BOC-11C 연체 후보·aging·독촉·수강 정지·해제와 정책 이력을 서버 정본으로 제공한다.
 * 책임/재사용: INV 기한 정본을 재사용하고 actual actor·멱등·version·schedule 직렬화를 같은 transaction에서 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11C-DELINQUENCY-SUSPENSION-2026-10-09.md · migration 1768300000000
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { invDueSql } from '../../lib/exec-areas';
import { todayKst } from '../../lib/kst';
import { NOTI_TITLE } from '../../lib/noti';
import { studentTagSql } from '../../lib/student-label';
import { lockDelinquencyScheduleWrite } from '../../lib/delinquency-suspension.db';
import type {
  DelinquencyPolicyDto, DelinquencyPolicyWriteDto, DelinquencySuspensionAction,
  DelinquencySuspensionActionDto, DelinquencySuspensionEventDto, DelinquencySuspensionItemDto,
  DelinquencySuspensionLedgerDto, DelinquencySuspensionWriteResultDto,
  DelinquencyReminderBatchDto, DelinquencyReminderBatchResultDto,
} from './accounting.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource | EntityManager, 'query'>;
type Transition = 'remind' | 'suspend' | 'release';

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: unknown): string | null => value == null ? null : new Date(String(value)).toISOString();
const maskPhone = (phone: unknown): string | null => {
  if (phone == null) return null;
  const digits = String(phone);
  if (digits.length < 8) return null;
  return `${digits.slice(0, 3)}-${'*'.repeat(Math.max(3, digits.length - 7))}-${digits.slice(-4)}`;
};

const OPEN = "'sent','unpaid','partial'";
const CANDIDATE_SQL = `WITH owed AS (
  SELECT i.student_id,(i.amount-i.paid_amount)::bigint AS balance,${invDueSql('i')} AS due_on
    FROM inv i
   WHERE i.state IN (${OPEN}) AND i.amount>i.paid_amount
), amounts AS (
  SELECT student_id,COALESCE(sum(balance),0)::bigint AS total_receivable,
         COALESCE(sum(balance) FILTER (WHERE due_on<$1::date),0)::bigint AS overdue_outstanding,
         count(*) FILTER (WHERE due_on<$1::date)::int AS overdue_invoice_count,
         COALESCE(max($1::date-due_on) FILTER (WHERE due_on<$1::date),0)::int AS overdue_days
    FROM owed GROUP BY student_id
), ids AS (
  SELECT student_id FROM amounts
  UNION SELECT student_id FROM delinquency_suspension
)
SELECT ids.student_id,s.name AS student_name,${studentTagSql('s')} AS student_tag,
       COALESCE(a.total_receivable,0)::bigint AS total_receivable,
       COALESCE(a.overdue_outstanding,0)::bigint AS overdue_outstanding,
       COALESCE(a.overdue_invoice_count,0)::int AS overdue_invoice_count,
       COALESCE(a.overdue_days,0)::int AS overdue_days,
       d.state AS suspension_state,COALESCE(d.row_version,0)::int AS row_version,
       d.suspended_at,sb.name AS suspended_by_name,
       g.name AS guardian_name,g.phone AS guardian_phone,
       COALESCE(ls.series_count,0)::int AS series_count,COALESCE(ls.series_names,ARRAY[]::text[]) AS series_names
  FROM ids JOIN stu s ON s.id=ids.student_id
  LEFT JOIN amounts a ON a.student_id=ids.student_id
  LEFT JOIN delinquency_suspension d ON d.student_id=ids.student_id
  LEFT JOIN staff sb ON sb.id=d.suspended_by
  LEFT JOIN LATERAL (
    SELECT x.name,x.phone FROM guardian x
     WHERE x.student_id=ids.student_id AND x.active AND x.phone IS NOT NULL
     ORDER BY x.is_payer DESC,x.is_primary DESC,x.id LIMIT 1
  ) g ON true
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT ss.ser_id)::int AS series_count,
           array_agg(DISTINCT COALESCE(NULLIF(sr.title,''),coalesce(su.name,k.name)) ORDER BY COALESCE(NULLIF(sr.title,''),coalesce(su.name,k.name))) AS series_names
      FROM ser_stu ss JOIN ser sr ON sr.id=ss.ser_id JOIN kind k ON k.key=sr.kind_key
      LEFT JOIN sub su ON su.key=sr.sub_key
     WHERE ss.student_id=ids.student_id
       AND (ss.from_date IS NULL OR ss.from_date<=$1::date) AND (ss.to_date IS NULL OR ss.to_date>=$1::date)
       AND (sr.to_date IS NULL OR sr.to_date>=$1::date)
  ) ls ON true`;

@Injectable()
export class DelinquencySuspensionsService {
  constructor(private readonly ds: DataSource) {}

  private async policy(q: Queryable, canChange: boolean): Promise<DelinquencyPolicyDto> {
    const [row] = await q.query(`SELECT p.threshold_days,p.row_version,p.updated_at,s.name AS updated_by
      FROM delinquency_policy p LEFT JOIN staff s ON s.id=p.updated_by WHERE p.id=1`) as Row[];
    if (!row) throw new ConflictException({ code: 'DELINQUENCY_POLICY_MISSING', message: '연체 정지 기준이 준비되지 않았습니다' });
    return {
      thresholdDays: Number(row.threshold_days), version: Number(row.row_version),
      updatedAt: iso(row.updated_at), updatedBy: row.updated_by == null ? null : String(row.updated_by), canChange,
    };
  }

  private async events(q: Queryable, studentIds: number[]): Promise<Map<number, DelinquencySuspensionEventDto[]>> {
    const out = new Map<number, DelinquencySuspensionEventDto[]>();
    if (!studentIds.length) return out;
    const rows = await q.query(`SELECT e.student_id,e.action,e.from_state,e.to_state,e.result_version,e.actor_id,
        s.name AS actor_name,e.reason,e.overdue_days,e.outstanding,e.affected_series_count,e.created_at
      FROM delinquency_suspension_event e JOIN staff s ON s.id=e.actor_id
      WHERE e.student_id=ANY($1::bigint[]) ORDER BY e.student_id,e.created_at,e.id`, [studentIds]) as Row[];
    for (const row of rows) {
      const id = Number(row.student_id);
      const bucket = out.get(id) ?? [];
      bucket.push({
        action: String(row.action) as DelinquencySuspensionAction,
        fromState: row.from_state == null ? null : String(row.from_state),
        toState: row.to_state == null ? null : String(row.to_state),
        version: Number(row.result_version), actorId: Number(row.actor_id), actor: String(row.actor_name),
        reason: row.reason == null ? null : String(row.reason), overdueDays: Number(row.overdue_days),
        outstanding: Number(row.outstanding), affectedSeriesCount: Number(row.affected_series_count),
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
      out.set(id, bucket);
    }
    return out;
  }

  private shape(
    row: Row, canWrite: boolean, threshold: number, events: DelinquencySuspensionEventDto[],
  ): DelinquencySuspensionItemDto {
    const suspended = String(row.suspension_state) === 'suspended';
    const outstanding = Number(row.overdue_outstanding);
    const candidate = !suspended && outstanding > 0 && Number(row.overdue_days) >= threshold;
    const released = !suspended && !candidate && String(row.suspension_state) === 'released';
    const state = suspended ? 'suspended' : candidate ? 'candidate' : released ? 'released' : 'candidate';
    const contact = maskPhone(row.guardian_phone);
    return {
      studentId: Number(row.student_id), studentName: String(row.student_name),
      studentTag: row.student_tag == null ? null : String(row.student_tag),
      contact: contact ? `${row.guardian_name == null ? '보호자' : String(row.guardian_name)} ${contact}` : null,
      overdueDays: Number(row.overdue_days), outstanding, overdueInvoiceCount: Number(row.overdue_invoice_count),
      affectedSeriesCount: Number(row.series_count), affectedSeries: (row.series_names as string[] | null) ?? [],
      state, stateLabel: state === 'suspended' ? '수강 정지' : state === 'candidate' ? '보류 대상' : '정지 해제',
      version: Number(row.row_version), suspendedAt: suspended ? iso(row.suspended_at) : null,
      suspendedBy: suspended && row.suspended_by_name != null ? String(row.suspended_by_name) : null,
      canRemind: canWrite && outstanding > 0 && (candidate || suspended), canSuspend: canWrite && candidate,
      canRelease: canWrite && suspended && outstanding === 0,
      releaseBlockedReason: suspended && outstanding > 0 ? '기한이 지난 미수 잔액을 모두 확인한 뒤 해제할 수 있습니다' : null,
      events,
    };
  }

  private async rows(q: Queryable, asOf: string, threshold: number, forceStudentId?: number): Promise<Row[]> {
    const where = forceStudentId === undefined
      ? `(COALESCE(a.overdue_days,0)>=$2 OR d.state IN ('suspended','released'))`
      : `ids.student_id=$2`;
    return q.query(`${CANDIDATE_SQL} WHERE ${where}
      ORDER BY d.state='suspended' DESC,COALESCE(a.overdue_days,0) DESC,d.state='released',s.name,s.id`,
    forceStudentId === undefined ? [asOf, threshold] : [asOf, forceStudentId]) as Promise<Row[]>;
  }

  async ledger(canWrite: boolean, canChangePolicy: boolean, asOf = todayKst()): Promise<DelinquencySuspensionLedgerDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '연체 수강 정지 원장 권한이 없습니다' });
    const policy = await this.policy(this.ds, canChangePolicy);
    const rows = await this.rows(this.ds, asOf, policy.thresholdDays);
    const history = await this.events(this.ds, rows.map((row) => Number(row.student_id)));
    const [summary] = await this.ds.query(`WITH owed AS (
        SELECT (i.amount-i.paid_amount)::bigint AS balance,${invDueSql('i')} AS due_on
          FROM inv i WHERE i.state IN (${OPEN}) AND i.amount>i.paid_amount
      ) SELECT COALESCE(sum(balance),0)::bigint AS receivable,
        COALESCE(sum(balance) FILTER(WHERE due_on<$1::date),0)::bigint AS overdue,
        COALESCE(sum(balance) FILTER(WHERE $1::date-due_on BETWEEN 1 AND 30),0)::bigint AS b1,
        COALESCE(sum(balance) FILTER(WHERE $1::date-due_on BETWEEN 31 AND 60),0)::bigint AS b2,
        COALESCE(sum(balance) FILTER(WHERE $1::date-due_on BETWEEN 61 AND 90),0)::bigint AS b3,
        COALESCE(sum(balance) FILTER(WHERE $1::date-due_on >=91),0)::bigint AS b4,
        count(DISTINCT student_id) FILTER(WHERE $1::date-due_on BETWEEN 1 AND 30)::int AS c1,
        count(DISTINCT student_id) FILTER(WHERE $1::date-due_on BETWEEN 31 AND 60)::int AS c2,
        count(DISTINCT student_id) FILTER(WHERE $1::date-due_on BETWEEN 61 AND 90)::int AS c3,
        count(DISTINCT student_id) FILTER(WHERE $1::date-due_on >=91)::int AS c4
      FROM (SELECT i.student_id,(i.amount-i.paid_amount)::bigint AS balance,${invDueSql('i')} AS due_on
              FROM inv i WHERE i.state IN (${OPEN}) AND i.amount>i.paid_amount) owed`, [asOf]) as Row[];
    const defs = [
      ['1_30', '1~30일', 'b1', 'c1'], ['31_60', '31~60일', 'b2', 'c2'],
      ['61_90', '61~90일', 'b3', 'c3'], ['91_plus', '90일 초과', 'b4', 'c4'],
    ] as const;
    return {
      asOf, policy, totalReceivable: Number(summary.receivable), totalOverdue: Number(summary.overdue),
      aging: defs.map(([key, label, amount, count]) => ({ key, label, outstanding: Number(summary[amount]), studentCount: Number(summary[count]) })),
      items: rows.map((row) => this.shape(row, canWrite, policy.thresholdDays, history.get(Number(row.student_id)) ?? [])),
    };
  }

  private async replay(
    m: EntityManager, studentId: number, actorId: number, action: DelinquencySuspensionAction,
    requestKey: string, fingerprint: string, canWrite: boolean,
  ): Promise<DelinquencySuspensionWriteResultDto | null> {
    const [prior] = await m.query(`SELECT actor_id,action,payload_sha256,result_version
      FROM delinquency_suspension_event WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({ code: 'DELINQUENCY_REQUEST_KEY_REUSED', message: '같은 요청 키를 다른 연체 처리에 다시 사용할 수 없습니다' });
    }
    const current = await this.currentVersion(m, studentId);
    if (current !== Number(prior.result_version)) {
      throw new ConflictException({ code: 'DELINQUENCY_REPLAY_STALE', message: '재시도 뒤 연체 정지 상태가 바뀌었습니다 — 원장을 다시 확인하세요' });
    }
    return { item: await this.one(m, studentId, canWrite), replayed: true };
  }

  private async currentVersion(q: Queryable, studentId: number): Promise<number> {
    const [row] = await q.query(`SELECT row_version FROM delinquency_suspension WHERE student_id=$1`, [studentId]) as Row[];
    return row ? Number(row.row_version) : 0;
  }

  private async one(q: Queryable, studentId: number, canWrite: boolean): Promise<DelinquencySuspensionItemDto> {
    const policy = await this.policy(q, false);
    const [row] = await this.rows(q, todayKst(), policy.thresholdDays, studentId);
    if (!row) throw new NotFoundException({ code: 'DELINQUENCY_STUDENT_NOT_FOUND', message: '학생의 연체 상태를 찾을 수 없습니다' });
    const history = await this.events(q, [studentId]);
    return this.shape(row, canWrite, policy.thresholdDays, history.get(studentId) ?? []);
  }

  async writePolicy(
    actorId: number, canChange: boolean, dto: DelinquencyPolicyWriteDto,
  ): Promise<DelinquencyPolicyDto> {
    if (!canChange) throw new ForbiddenException({ code: 'FORBIDDEN', message: '연체 정지 기준을 바꿀 권한이 없습니다' });
    const fingerprint = sha({ thresholdDays: dto.thresholdDays, expectedVersion: dto.expectedVersion });
    return this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('delinquency-policy'),hashtext($1))`, [dto.requestKey]);
      const [prior] = await m.query(`SELECT actor_id,payload_sha256,result_version FROM delinquency_policy_event WHERE request_key=$1`, [dto.requestKey]) as Row[];
      if (prior) {
        if (Number(prior.actor_id) !== actorId || String(prior.payload_sha256) !== fingerprint) {
          throw new ConflictException({ code: 'DELINQUENCY_POLICY_KEY_REUSED', message: '같은 요청 키를 다른 기준 변경에 사용할 수 없습니다' });
        }
        const current = await this.policy(m, true);
        if (current.version !== Number(prior.result_version)) {
          throw new ConflictException({ code: 'DELINQUENCY_POLICY_REPLAY_STALE', message: '재시도 뒤 기준이 다시 바뀌었습니다' });
        }
        return current;
      }
      const [current] = await m.query(`SELECT threshold_days,row_version FROM delinquency_policy WHERE id=1 FOR UPDATE`) as Row[];
      if (!current || Number(current.row_version) !== dto.expectedVersion) {
        throw new ConflictException({ code: 'DELINQUENCY_POLICY_STALE', message: '다른 기준 변경이 있습니다 — 다시 불러와 주세요' });
      }
      const version = Number(current.row_version) + 1;
      await m.query(`UPDATE delinquency_policy SET threshold_days=$1,row_version=$2,updated_by=$3,updated_at=now() WHERE id=1`, [dto.thresholdDays, version, actorId]);
      await m.query(`INSERT INTO delinquency_policy_event
        (actor_id,request_key,payload_sha256,threshold_before,threshold_after,result_version)
        VALUES($1,$2,$3,$4,$5,$6)`, [actorId, dto.requestKey, fingerprint, current.threshold_days, dto.thresholdDays, version]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after) VALUES($1,'DELINQ_POLICY',1,'update',$2::jsonb,$3::jsonb)`, [
        actorId, JSON.stringify({ thresholdDays: Number(current.threshold_days), version: dto.expectedVersion }),
        JSON.stringify({ thresholdDays: dto.thresholdDays, version }),
      ]);
      await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
        SELECT id,$1,$2,$3,'/accounting?tab=suspensions','request' FROM staff
         WHERE active AND role<>'teacher' AND id<>$1`, [actorId, NOTI_TITLE.delinquencyPolicyChanged, `연체 수강 정지 후보 기준이 ${dto.thresholdDays}일로 바뀌었습니다`]);
      return this.policy(m, true);
    });
  }

  private async transitionInTransaction(
    m: EntityManager,
    actorId: number, canWrite: boolean, studentId: number, transition: Transition, dto: DelinquencySuspensionActionDto,
  ): Promise<DelinquencySuspensionWriteResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '연체 수강 정지를 처리할 권한이 없습니다' });
    const reason = dto.reason?.trim() || null;
    if ((transition === 'suspend' || transition === 'release') && (!reason || reason.length < 2)) {
      throw new BadRequestException({ code: 'DELINQUENCY_REASON_REQUIRED', message: '정지·해제 사유를 두 글자 이상 입력해 주세요' });
    }
    const action: DelinquencySuspensionAction = transition === 'remind' ? 'reminded' : transition === 'suspend' ? 'suspended' : 'released';
    const fingerprint = sha({ studentId, transition, expectedVersion: dto.expectedVersion, reason });
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('delinquency-action'),hashtext($1))`, [dto.requestKey]);
      const replay = await this.replay(m, studentId, actorId, action, dto.requestKey, fingerprint, canWrite);
      if (replay) return replay;
      const [student] = await m.query(`SELECT id FROM stu WHERE id=$1 FOR UPDATE`, [studentId]) as Row[];
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      const [current] = await m.query(`SELECT * FROM delinquency_suspension WHERE student_id=$1 FOR UPDATE`, [studentId]) as Row[];
      const currentVersion = current ? Number(current.row_version) : 0;
      if (currentVersion !== dto.expectedVersion) {
        throw new ConflictException({ code: 'DELINQUENCY_STALE', message: '다른 연체 처리 결과가 있습니다 — 원장을 다시 불러와 주세요' });
      }
      const policy = await this.policy(m, false);
      const [snapshot] = await this.rows(m, todayKst(), policy.thresholdDays, studentId);
      if (!snapshot) throw new NotFoundException({ code: 'DELINQUENCY_STUDENT_NOT_FOUND', message: '학생의 회계 상태를 찾을 수 없습니다' });
      const overdueDays = Number(snapshot.overdue_days);
      const outstanding = Number(snapshot.overdue_outstanding);
      const affected = Number(snapshot.series_count);
      const fromState = String(current?.state ?? 'candidate');
      let resultVersion = currentVersion;
      let toState = fromState;
      if (transition === 'suspend') {
        if (fromState === 'suspended') throw new ConflictException({ code: 'DELINQUENCY_ALREADY_SUSPENDED', message: '이미 수강 정지 상태입니다' });
        if (overdueDays < policy.thresholdDays || outstanding <= 0) {
          throw new ConflictException({ code: 'DELINQUENCY_NOT_ELIGIBLE', message: '현재 연체 상태가 후보 기준에 미치지 않습니다' });
        }
        resultVersion += 1;
        toState = 'suspended';
        await m.query(`INSERT INTO delinquency_suspension
          (student_id,state,row_version,threshold_snapshot,overdue_days_snapshot,outstanding_snapshot,suspended_by,suspended_at,suspend_reason,updated_at)
          VALUES($1,'suspended',$2,$3,$4,$5,$6,now(),$7,now())
          ON CONFLICT(student_id) DO UPDATE SET state='suspended',row_version=EXCLUDED.row_version,
            threshold_snapshot=EXCLUDED.threshold_snapshot,overdue_days_snapshot=EXCLUDED.overdue_days_snapshot,
            outstanding_snapshot=EXCLUDED.outstanding_snapshot,suspended_by=EXCLUDED.suspended_by,suspended_at=now(),
            suspend_reason=EXCLUDED.suspend_reason,released_by=NULL,released_at=NULL,release_reason=NULL,updated_at=now()`,
        [studentId, resultVersion, policy.thresholdDays, overdueDays, outstanding, actorId, reason]);
      } else if (transition === 'release') {
        if (fromState !== 'suspended') throw new ConflictException({ code: 'DELINQUENCY_NOT_SUSPENDED', message: '현재 수강 정지 상태가 아닙니다' });
        if (outstanding > 0) {
          throw new ConflictException({ code: 'DELINQUENCY_RELEASE_BALANCE_REMAINS', message: '기한이 지난 미수 잔액을 모두 확인한 뒤 해제할 수 있습니다', outstanding });
        }
        resultVersion += 1;
        toState = 'released';
        await m.query(`UPDATE delinquency_suspension SET state='released',row_version=$2,released_by=$3,released_at=now(),
          release_reason=$4,overdue_days_snapshot=$5,outstanding_snapshot=$6,updated_at=now() WHERE student_id=$1`,
        [studentId, resultVersion, actorId, reason, overdueDays, outstanding]);
      }
      await m.query(`INSERT INTO delinquency_suspension_event
        (student_id,action,from_state,to_state,actor_id,request_key,payload_sha256,result_version,
         overdue_days,outstanding,affected_series_count,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [studentId, action, fromState, toState, actorId, dto.requestKey, fingerprint, resultVersion, overdueDays, outstanding, affected, reason]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after) VALUES($1,'DELINQ_SUSP',$2,$3,$4::jsonb,$5::jsonb)`, [
        actorId, studentId, transition,
        JSON.stringify({ state: fromState, version: currentVersion }),
        JSON.stringify({ state: toState, version: resultVersion, overdueDays, outstanding, affectedSeriesCount: affected }),
      ]);
      const title = transition === 'remind' ? NOTI_TITLE.delinquencyReminderRecorded
        : transition === 'suspend' ? NOTI_TITLE.delinquencySuspended : NOTI_TITLE.delinquencyReleased;
      const body = transition === 'remind' ? `${snapshot.student_name} 학생 납입 독촉 이력이 기록되었습니다`
        : transition === 'suspend' ? `${snapshot.student_name} 학생의 신규 일정 저장이 보류되었습니다`
          : `${snapshot.student_name} 학생의 수강 정지가 해제되었습니다`;
      await m.query(`INSERT INTO noti(to_id,from_id,title,body,link,category)
        SELECT id,$1,$2,$3,$4,'request' FROM staff
         WHERE active AND role<>'teacher' AND id<>$1`, [actorId, title, body, '/accounting?tab=suspensions']);
    return { item: await this.one(m, studentId, canWrite), replayed: false };
  }

  async transition(
    actorId: number, canWrite: boolean, studentId: number, transition: Transition, dto: DelinquencySuspensionActionDto,
  ): Promise<DelinquencySuspensionWriteResultDto> {
    return this.ds.transaction(async (m) => {
      await lockDelinquencyScheduleWrite(m as unknown as Pick<import('typeorm').QueryRunner, 'query'>);
      return this.transitionInTransaction(m, actorId, canWrite, studentId, transition, dto);
    });
  }

  async remindBatch(
    actorId: number, canWrite: boolean, dto: DelinquencyReminderBatchDto,
  ): Promise<DelinquencyReminderBatchResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '연체 수강 정지를 처리할 권한이 없습니다' });
    const studentIds = dto.items.map((item) => item.studentId);
    if (new Set(studentIds).size !== studentIds.length) {
      throw new BadRequestException({ code: 'DELINQUENCY_BATCH_DUPLICATE_STUDENT', message: '일괄 독촉 학생은 중복할 수 없습니다' });
    }
    return this.ds.transaction(async (m) => {
      await lockDelinquencyScheduleWrite(m as unknown as Pick<import('typeorm').QueryRunner, 'query'>);
      const items: DelinquencySuspensionWriteResultDto[] = [];
      for (const item of [...dto.items].sort((a, b) => a.studentId - b.studentId)) {
        items.push(await this.transitionInTransaction(m, actorId, canWrite, item.studentId, 'remind', item));
      }
      return {
        remindedCount: items.length,
        replayedCount: items.filter((item) => item.replayed).length,
        items,
      };
    });
  }
}
