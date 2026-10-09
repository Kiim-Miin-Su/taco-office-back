/** @file-guide
 * 목적: TBO-55 BOC-11E 시간당 수업료 정책의 조회·생성·교체·종료와 감사 원장을 소유한다.
 * 책임/재사용: 기존 회당 RATE/STURATE를 수정하지 않고 actual occurrence pricing이 읽는 기간 정책만 관리한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11E-HOURLY-RATE-POLICY-2026-10-09.md · migration 1768600000000
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { addDays, todayKst } from '../../lib/kst';
import { studentTagSql } from '../../lib/student-label';
import type {
  HourlyRateCreateDto, HourlyRatePolicyDto, HourlyRatePolicyEventDto, HourlyRateReplaceDto,
  HourlyRateRetireDto, HourlyRateScope, HourlyRateState, HourlyRateWriteResultDto,
} from './accounting.dto';

type Row = Record<string, unknown>;
type Action = 'created' | 'replaced' | 'retired';

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nullable = (value: unknown): string | null => value == null ? null : String(value);
const iso = (value: unknown): string => new Date(String(value)).toISOString();
const dateOnly = (value: unknown): string => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(String(value));
  return todayKst(date.getTime());
};

const POLICY_SELECT = `SELECT p.id,p.scope,p.student_id,p.kind_key,p.capacity,p.hourly_amount,
  to_char(p.effective_from,'YYYY-MM-DD') AS effective_from,
  to_char(p.effective_to,'YYYY-MM-DD') AS effective_to,
  p.reason,p.row_version,p.voided,p.created_at,p.updated_at,
  st.name AS student_name,${studentTagSql('st')} AS student_tag,k.name AS kind_name,
  cb.name AS created_by_name,ub.name AS updated_by_name,
  CASE WHEN p.student_id IS NULL THEN NULL ELSE COALESCE((
    SELECT m.marked FROM stu_kinder_marker m
     WHERE m.student_id=p.student_id AND m.effective_from<=now()
     ORDER BY m.effective_from DESC,m.version DESC LIMIT 1
  ),false) END AS student_kinder_marked
 FROM hourly_rate_policy p
 LEFT JOIN stu st ON st.id=p.student_id
 LEFT JOIN kind k ON k.key=p.kind_key
 JOIN staff cb ON cb.id=p.created_by
 JOIN staff ub ON ub.id=p.updated_by`;

@Injectable()
export class HourlyRatesService {
  constructor(private readonly ds: DataSource) {}

  private state(row: Row, today: string): HourlyRateState {
    if (row.voided === true) return 'voided';
    const from = String(row.effective_from);
    const to = nullable(row.effective_to);
    if (from > today) return 'scheduled';
    if (to !== null && to < today) return 'ended';
    return 'current';
  }

  private async events(q: DataSource | EntityManager, ids: number[]): Promise<Map<number, HourlyRatePolicyEventDto[]>> {
    const map = new Map<number, HourlyRatePolicyEventDto[]>();
    if (ids.length === 0) return map;
    const rows = await q.query(`SELECT e.policy_id,e.action,e.result_version,e.hourly_amount,
        to_char(e.effective_from,'YYYY-MM-DD') AS effective_from,
        to_char(e.effective_to,'YYYY-MM-DD') AS effective_to,
        e.reason,e.voided,e.created_at,s.name AS actor_name
      FROM hourly_rate_policy_event e JOIN staff s ON s.id=e.actor_id
      WHERE e.policy_id=ANY($1::bigint[]) ORDER BY e.policy_id,e.result_version`, [ids]) as Row[];
    for (const row of rows) {
      const policyId = Number(row.policy_id);
      const bucket = map.get(policyId) ?? [];
      bucket.push({
        action: String(row.action) as HourlyRatePolicyEventDto['action'], version: Number(row.result_version),
        hourlyAmount: Number(row.hourly_amount), effectiveFrom: String(row.effective_from),
        effectiveTo: nullable(row.effective_to), reason: nullable(row.reason), voided: row.voided === true,
        actor: String(row.actor_name), createdAt: iso(row.created_at),
      });
      map.set(policyId, bucket);
    }
    return map;
  }

  private shape(
    row: Row, today: string, history: HourlyRatePolicyEventDto[], basisHourlyAmount: number | null,
  ): HourlyRatePolicyDto {
    const scope = String(row.scope) as HourlyRateScope;
    const hourlyAmount = Number(row.hourly_amount);
    const state = this.state(row, today);
    // 오늘까지 가격 적용은 유지하되, 교체·종료 영수증이 생긴 원본은 같은 날에도 다시 바꿀 수 없다.
    const transitionClosed = ['superseded', 'retired'].includes(history.at(-1)?.action ?? '');
    return {
      id: Number(row.id), scope,
      studentId: row.student_id == null ? null : Number(row.student_id),
      studentName: nullable(row.student_name), studentTag: nullable(row.student_tag),
      studentKinderMarked: row.student_kinder_marked == null ? null : row.student_kinder_marked === true,
      kindKey: nullable(row.kind_key), kindName: nullable(row.kind_name),
      capacity: row.capacity == null ? null : Number(row.capacity), hourlyAmount,
      totalHourlyAmount: scope === 'group' ? hourlyAmount * Number(row.capacity) : null,
      basisHourlyAmount,
      basisPercent: basisHourlyAmount === null ? null : Math.round((hourlyAmount / basisHourlyAmount) * 1000) / 10,
      effectiveFrom: String(row.effective_from), effectiveTo: nullable(row.effective_to), reason: nullable(row.reason),
      version: Number(row.row_version), state,
      createdBy: String(row.created_by_name), updatedBy: String(row.updated_by_name),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      canEdit: !transitionClosed && (state === 'scheduled' || state === 'current'),
      canRetire: !transitionClosed && (state === 'scheduled' || state === 'current'),
      events: history,
    };
  }

  private async rows(q: DataSource | EntityManager): Promise<Row[]> {
    return q.query(`${POLICY_SELECT}
      ORDER BY CASE p.scope WHEN 'general' THEN 1 WHEN 'kinder' THEN 2 WHEN 'group' THEN 3 ELSE 4 END,
        p.capacity NULLS FIRST,st.name NULLS FIRST,p.effective_from DESC,p.id DESC`) as Promise<Row[]>;
  }

  private async shaped(q: DataSource | EntityManager, onlyId?: number): Promise<HourlyRatePolicyDto[]> {
    const today = todayKst();
    const rows = await this.rows(q);
    const history = await this.events(q, rows.map((row) => Number(row.id)));
    const currentBase = (scope: 'general' | 'kinder'): number | null => {
      const row = rows.find((candidate) => String(candidate.scope) === scope && candidate.voided !== true
        && String(candidate.effective_from) <= today
        && (candidate.effective_to == null || String(candidate.effective_to) >= today));
      return row ? Number(row.hourly_amount) : null;
    };
    return rows
      .filter((row) => onlyId === undefined || Number(row.id) === onlyId)
      .map((row) => {
        const basis = String(row.scope) === 'student'
          ? currentBase(row.student_kinder_marked === true ? 'kinder' : 'general')
          : null;
        return this.shape(row, today, history.get(Number(row.id)) ?? [], basis);
      });
  }

  async list(): Promise<HourlyRatePolicyDto[]> {
    return this.shaped(this.ds);
  }

  private async one(q: DataSource | EntityManager, id: number): Promise<HourlyRatePolicyDto> {
    const [item] = await this.shaped(q, id);
    if (!item) throw new NotFoundException({ code: 'HOURLY_RATE_NOT_FOUND', message: '시간당 단가 정책을 찾을 수 없습니다' });
    return item;
  }

  private validatePeriod(effectiveFrom: string, effectiveTo?: string): void {
    const today = todayKst();
    if (effectiveFrom < today) {
      throw new ConflictException({
        code: 'HOURLY_RATE_RETROACTIVE', message: `시간당 단가는 오늘(${today}) 이후 실제 수업부터 적용할 수 있습니다`,
      });
    }
    if (effectiveTo !== undefined && effectiveTo < effectiveFrom) {
      throw new BadRequestException({ code: 'HOURLY_RATE_BAD_PERIOD', message: '종료일은 시작일과 같거나 뒤여야 합니다' });
    }
  }

  private async validateIdentity(m: EntityManager, dto: HourlyRateCreateDto): Promise<void> {
    if (dto.scope === 'student') {
      if (dto.studentId === undefined || dto.capacity !== undefined) {
        throw new BadRequestException({ code: 'HOURLY_RATE_SCOPE_SHAPE', message: '학생 예외에는 학생이 필요하고 정원은 둘 수 없습니다' });
      }
      const [student] = await m.query(`SELECT id FROM stu WHERE id=$1`, [dto.studentId]) as Row[];
      if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다' });
      if (!dto.reason?.trim()) {
        throw new BadRequestException({ code: 'HOURLY_RATE_REASON_REQUIRED', message: '학생별 시간당 예외에는 사유가 필요합니다' });
      }
      if (dto.kindKey) {
        const [kind] = await m.query(`SELECT key FROM kind WHERE key=$1`, [dto.kindKey]) as Row[];
        if (!kind) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '수업 종류를 찾을 수 없습니다' });
      }
      return;
    }
    if (dto.studentId !== undefined || dto.kindKey !== undefined) {
      throw new BadRequestException({ code: 'HOURLY_RATE_SCOPE_SHAPE', message: '일반·Kinder·그룹 기준에는 학생이나 수업 종류를 둘 수 없습니다' });
    }
    if (dto.scope === 'group' && dto.capacity === undefined) {
      throw new BadRequestException({ code: 'HOURLY_RATE_SCOPE_SHAPE', message: '그룹 기준에는 2명 이상의 정원이 필요합니다' });
    }
    if (dto.scope !== 'group' && dto.capacity !== undefined) {
      throw new BadRequestException({ code: 'HOURLY_RATE_SCOPE_SHAPE', message: '정원은 그룹 기준에만 둘 수 있습니다' });
    }
  }

  private async lockRequest(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('hourly-rate-request'),hashtext($1))`, [requestKey]);
  }

  private async replay(
    m: EntityManager, requestKey: string, actorId: number, action: Action,
    sourcePolicyId: number | null, expectedVersion: number, fingerprint: string,
  ): Promise<HourlyRateWriteResultDto | null> {
    const [prior] = await m.query(`SELECT actor_id,action,source_policy_id,expected_version,payload_sha256,
        result_policy_id,result_version FROM hourly_rate_policy_request WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    if (Number(prior.actor_id) !== actorId || String(prior.action) !== action
      || (prior.source_policy_id == null ? null : Number(prior.source_policy_id)) !== sourcePolicyId
      || Number(prior.expected_version) !== expectedVersion || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'HOURLY_RATE_KEY_REUSED', message: '같은 요청 키를 다른 시간당 단가 작업에 다시 사용할 수 없습니다',
      });
    }
    const [current] = await m.query(`SELECT row_version FROM hourly_rate_policy WHERE id=$1`, [prior.result_policy_id]) as Row[];
    if (!current || Number(current.row_version) !== Number(prior.result_version)) {
      throw new ConflictException({
        code: 'HOURLY_RATE_REPLAY_STALE', message: '재시도한 요청 뒤에 시간당 단가가 다시 바뀌었습니다 — 최신 목록을 확인하세요',
      });
    }
    return { item: await this.one(m, Number(prior.result_policy_id)), replayed: true };
  }

  private stale(expectedVersion: number, actualVersion: number): never {
    throw new ConflictException({
      code: 'HOURLY_RATE_STALE', message: '시간당 단가가 다른 작업에서 바뀌었습니다 — 다시 불러와 주세요',
      details: { expectedVersion, actualVersion },
    });
  }

  private translate(error: unknown): never {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23P01' && pg.constraint === 'hourly_rate_policy_no_overlap') {
      throw new ConflictException({
        code: 'HOURLY_RATE_OVERLAP', message: '같은 적용 대상의 시간당 단가 기간이 겹칩니다 — 기간을 다시 확인하세요',
      });
    }
    throw error;
  }

  private async assertTransitionOpen(m: EntityManager, policyId: number): Promise<void> {
    const [last] = await m.query(`SELECT action FROM hourly_rate_policy_event
      WHERE policy_id=$1 ORDER BY result_version DESC LIMIT 1`, [policyId]) as Row[];
    if (last && ['superseded', 'retired'].includes(String(last.action))) {
      throw new ConflictException({
        code: 'HOURLY_RATE_NOT_ACTIVE', message: '이미 교체·종료되거나 취소된 단가입니다',
      });
    }
  }

  async create(actorId: number, dto: HourlyRateCreateDto): Promise<HourlyRateWriteResultDto> {
    this.validatePeriod(dto.effectiveFrom, dto.effectiveTo);
    const reason = dto.reason?.trim() || null;
    const identity = { scope: dto.scope, studentId: dto.studentId ?? null, kindKey: dto.kindKey ?? null, capacity: dto.capacity ?? null };
    const fingerprint = sha({ ...identity, hourlyAmount: dto.hourlyAmount, effectiveFrom: dto.effectiveFrom, effectiveTo: dto.effectiveTo ?? null, reason });
    try {
      return await this.ds.transaction(async (m) => {
        await this.lockRequest(m, dto.requestKey);
        const prior = await this.replay(m, dto.requestKey, actorId, 'created', null, 0, fingerprint);
        if (prior) return prior;
        await this.validateIdentity(m, dto);
        await m.query(`SELECT pg_advisory_xact_lock(hashtext('hourly-rate-identity'),hashtext($1))`, [JSON.stringify(identity)]);
        const [made] = await m.query(`INSERT INTO hourly_rate_policy(
            scope,student_id,kind_key,capacity,hourly_amount,effective_from,effective_to,reason,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$9) RETURNING id,row_version`, [
          dto.scope, dto.studentId ?? null, dto.kindKey ?? null, dto.capacity ?? null, dto.hourlyAmount,
          dto.effectiveFrom, dto.effectiveTo ?? null, reason, actorId,
        ]) as Row[];
        const policyId = Number(made.id);
        await m.query(`INSERT INTO hourly_rate_policy_request(
            request_key,actor_id,action,source_policy_id,expected_version,payload_sha256,result_policy_id,result_version)
          VALUES($1,$2,'created',NULL,0,$3,$4,1)`, [dto.requestKey, actorId, fingerprint, policyId]);
        await m.query(`INSERT INTO hourly_rate_policy_event(
            policy_id,action,actor_id,request_key,result_version,hourly_amount,effective_from,effective_to,reason,voided)
          VALUES($1,'created',$2,$3,1,$4,$5::date,$6::date,$7,false)`, [
          policyId, actorId, dto.requestKey, dto.hourlyAmount, dto.effectiveFrom, dto.effectiveTo ?? null, reason,
        ]);
        await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,after)
          VALUES($1,'HOURLY_RATE_POLICY',$2,'create',$3::jsonb)`, [actorId, policyId, JSON.stringify({ ...identity,
          hourlyAmount: dto.hourlyAmount, effectiveFrom: dto.effectiveFrom, effectiveTo: dto.effectiveTo ?? null, reason, version: 1,
        })]);
        return { item: await this.one(m, policyId), replayed: false };
      });
    } catch (error) {
      return this.translate(error);
    }
  }

  async replace(actorId: number, policyId: number, dto: HourlyRateReplaceDto): Promise<HourlyRateWriteResultDto> {
    this.validatePeriod(dto.effectiveFrom, dto.effectiveTo);
    const today = todayKst();
    if (dto.effectiveFrom <= today) {
      throw new ConflictException({
        code: 'HOURLY_RATE_REPLACE_FUTURE_ONLY', message: '진행 중인 단가는 내일 이후 실제 수업부터 교체할 수 있습니다',
      });
    }
    const reason = dto.reason.trim();
    const fingerprint = sha({ policyId, expectedVersion: dto.expectedVersion, hourlyAmount: dto.hourlyAmount,
      effectiveFrom: dto.effectiveFrom, effectiveTo: dto.effectiveTo ?? null, reason });
    try {
      return await this.ds.transaction(async (m) => {
        await this.lockRequest(m, dto.requestKey);
        const prior = await this.replay(m, dto.requestKey, actorId, 'replaced', policyId, dto.expectedVersion, fingerprint);
        if (prior) return prior;
        const [source] = await m.query(`SELECT * FROM hourly_rate_policy WHERE id=$1 FOR UPDATE`, [policyId]) as Row[];
        if (!source) throw new NotFoundException({ code: 'HOURLY_RATE_NOT_FOUND', message: '시간당 단가 정책을 찾을 수 없습니다' });
        const actualVersion = Number(source.row_version);
        if (actualVersion !== dto.expectedVersion) this.stale(dto.expectedVersion, actualVersion);
        await this.assertTransitionOpen(m, policyId);
        const sourceState = this.state({ ...source,
          effective_from: dateOnly(source.effective_from),
          effective_to: source.effective_to == null ? null : dateOnly(source.effective_to),
        }, today);
        if (sourceState === 'ended' || sourceState === 'voided') {
          throw new ConflictException({ code: 'HOURLY_RATE_NOT_ACTIVE', message: '종료되거나 취소된 단가는 교체할 수 없습니다' });
        }
        const sourceFrom = dateOnly(source.effective_from);
        const sourceTo = source.effective_to == null ? null : dateOnly(source.effective_to);
        const nextOldVersion = actualVersion + 1;
        const scheduled = sourceFrom > today;
        const closedTo = scheduled ? sourceTo : (sourceTo !== null && sourceTo < dto.effectiveFrom ? sourceTo : addDays(dto.effectiveFrom, -1));
        await m.query(`UPDATE hourly_rate_policy SET effective_to=$2::date,reason=$3,voided=$4,row_version=$5,updated_by=$6
          WHERE id=$1`, [policyId, closedTo, reason, scheduled, nextOldVersion, actorId]);
        const [made] = await m.query(`INSERT INTO hourly_rate_policy(
            scope,student_id,kind_key,capacity,hourly_amount,effective_from,effective_to,reason,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$9) RETURNING id`, [
          source.scope, source.student_id, source.kind_key, source.capacity, dto.hourlyAmount,
          dto.effectiveFrom, dto.effectiveTo ?? null, reason, actorId,
        ]) as Row[];
        const resultPolicyId = Number(made.id);
        await m.query(`INSERT INTO hourly_rate_policy_request(
            request_key,actor_id,action,source_policy_id,expected_version,payload_sha256,result_policy_id,result_version)
          VALUES($1,$2,'replaced',$3,$4,$5,$6,1)`, [
          dto.requestKey, actorId, policyId, dto.expectedVersion, fingerprint, resultPolicyId,
        ]);
        await m.query(`INSERT INTO hourly_rate_policy_event(
            policy_id,action,actor_id,request_key,result_version,hourly_amount,effective_from,effective_to,reason,voided)
          VALUES($1,'superseded',$2,$3,$4,$5,$6::date,$7::date,$8,$9)`, [
          policyId, actorId, dto.requestKey, nextOldVersion, source.hourly_amount, sourceFrom, closedTo, reason, scheduled,
        ]);
        await m.query(`INSERT INTO hourly_rate_policy_event(
            policy_id,action,actor_id,request_key,result_version,hourly_amount,effective_from,effective_to,reason,voided)
          VALUES($1,'created',$2,$3,1,$4,$5::date,$6::date,$7,false)`, [
          resultPolicyId, actorId, dto.requestKey, dto.hourlyAmount, dto.effectiveFrom, dto.effectiveTo ?? null, reason,
        ]);
        await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
          VALUES($1,'HOURLY_RATE_POLICY',$2,'replace',$3::jsonb,$4::jsonb)`, [actorId, resultPolicyId,
          JSON.stringify({ policyId, version: actualVersion, hourlyAmount: Number(source.hourly_amount), effectiveFrom: sourceFrom, effectiveTo: sourceTo }),
          JSON.stringify({ sourcePolicyId: policyId, sourceVersion: nextOldVersion, policyId: resultPolicyId, version: 1,
            hourlyAmount: dto.hourlyAmount, effectiveFrom: dto.effectiveFrom, effectiveTo: dto.effectiveTo ?? null, reason }),
        ]);
        return { item: await this.one(m, resultPolicyId), replayed: false };
      });
    } catch (error) {
      return this.translate(error);
    }
  }

  async retire(actorId: number, policyId: number, dto: HourlyRateRetireDto): Promise<HourlyRateWriteResultDto> {
    const reason = dto.reason.trim();
    const fingerprint = sha({ policyId, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await this.lockRequest(m, dto.requestKey);
      const prior = await this.replay(m, dto.requestKey, actorId, 'retired', policyId, dto.expectedVersion, fingerprint);
      if (prior) return prior;
      const [source] = await m.query(`SELECT * FROM hourly_rate_policy WHERE id=$1 FOR UPDATE`, [policyId]) as Row[];
      if (!source) throw new NotFoundException({ code: 'HOURLY_RATE_NOT_FOUND', message: '시간당 단가 정책을 찾을 수 없습니다' });
      const actualVersion = Number(source.row_version);
      if (actualVersion !== dto.expectedVersion) this.stale(dto.expectedVersion, actualVersion);
      await this.assertTransitionOpen(m, policyId);
      const today = todayKst();
      const sourceFrom = dateOnly(source.effective_from);
      const sourceTo = source.effective_to == null ? null : dateOnly(source.effective_to);
      const sourceState = this.state({ ...source, effective_from: sourceFrom, effective_to: sourceTo }, today);
      if (sourceState === 'ended' || sourceState === 'voided') {
        throw new ConflictException({ code: 'HOURLY_RATE_NOT_ACTIVE', message: '이미 종료되거나 취소된 단가입니다' });
      }
      const scheduled = sourceState === 'scheduled';
      const nextVersion = actualVersion + 1;
      const effectiveTo = scheduled ? sourceTo : today;
      await m.query(`UPDATE hourly_rate_policy SET effective_to=$2::date,reason=$3,voided=$4,row_version=$5,updated_by=$6
        WHERE id=$1`, [policyId, effectiveTo, reason, scheduled, nextVersion, actorId]);
      await m.query(`INSERT INTO hourly_rate_policy_request(
          request_key,actor_id,action,source_policy_id,expected_version,payload_sha256,result_policy_id,result_version)
        VALUES($1,$2,'retired',$3,$4,$5,$3,$6)`, [dto.requestKey, actorId, policyId, dto.expectedVersion, fingerprint, nextVersion]);
      await m.query(`INSERT INTO hourly_rate_policy_event(
          policy_id,action,actor_id,request_key,result_version,hourly_amount,effective_from,effective_to,reason,voided)
        VALUES($1,'retired',$2,$3,$4,$5,$6::date,$7::date,$8,$9)`, [
        policyId, actorId, dto.requestKey, nextVersion, source.hourly_amount, sourceFrom, effectiveTo, reason, scheduled,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'HOURLY_RATE_POLICY',$2,'retire',$3::jsonb,$4::jsonb)`, [actorId, policyId,
        JSON.stringify({ version: actualVersion, effectiveTo: sourceTo, voided: false }),
        JSON.stringify({ version: nextVersion, effectiveTo, voided: scheduled, reason }),
      ]);
      return { item: await this.one(m, policyId), replayed: false };
    });
  }
}
