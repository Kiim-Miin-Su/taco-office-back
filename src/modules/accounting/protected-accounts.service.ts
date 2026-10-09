/** @file-guide
 * 목적: BOC-11D-01 보호 계좌의 masked 조회·암호화 저장·삭제·목적 있는 원문 확인을 구현한다.
 * 책임/재사용: 전용 capability는 controller, secret envelope·version·멱등·감사·대상 검증은 이 서비스가 소유한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-11D1-PROTECTED-ACCOUNT-2026-10-09.md · migration 1768400000000
 */
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { openProtectedAccount, sealProtectedAccount } from '../../lib/protected-account-crypto';
import { studentTagSql } from '../../lib/student-label';
import type {
  ProtectedAccountActionDto, ProtectedAccountDto, ProtectedAccountEventDto, ProtectedAccountLedgerDto,
  ProtectedAccountPurpose, ProtectedAccountSecretDto, ProtectedAccountState, ProtectedAccountWriteDto,
  ProtectedAccountWriteResultDto,
} from './accounting.dto';

type Row = Record<string, unknown>;
type AccountAction = 'created' | 'updated' | 'deleted' | 'revealed';

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BASE_SELECT = `SELECT a.id,a.purpose,a.target_id,a.state,a.row_version,a.ciphertext,a.key_version,a.last4,
    a.updated_at,u.name AS updated_by_name,
    CASE WHEN a.purpose='student_refund' THEN s.name ELSE t.name END AS target_name,
    CASE WHEN a.purpose='student_refund' THEN ${studentTagSql('s')} ELSE NULL END AS target_tag
  FROM protected_account a
  JOIN staff u ON u.id=a.updated_by
  LEFT JOIN stu s ON a.purpose='student_refund' AND s.id=a.target_id
  LEFT JOIN staff t ON a.purpose='teacher_payout' AND t.id=a.target_id`;

@Injectable()
export class ProtectedAccountsService {
  constructor(private readonly ds: DataSource) {}

  private async lockRequestKey(m: EntityManager, requestKey: string): Promise<void> {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('protected-account'),hashtext($1))`, [requestKey]);
  }

  private async events(q: DataSource | EntityManager, accountIds: number[]): Promise<Map<number, ProtectedAccountEventDto[]>> {
    const map = new Map<number, ProtectedAccountEventDto[]>();
    if (!accountIds.length) return map;
    const rows = await q.query(`SELECT e.account_id,e.action,e.from_state,e.to_state,e.result_version,
        e.reason,e.created_at,s.name AS actor_name
      FROM protected_account_event e JOIN staff s ON s.id=e.actor_id
      WHERE e.account_id=ANY($1::bigint[]) ORDER BY e.account_id,e.created_at,e.id`, [accountIds]) as Row[];
    for (const row of rows) {
      const accountId = Number(row.account_id);
      const bucket = map.get(accountId) ?? [];
      bucket.push({
        action: String(row.action) as ProtectedAccountEventDto['action'],
        fromState: row.from_state == null ? null : String(row.from_state) as ProtectedAccountState,
        toState: String(row.to_state) as ProtectedAccountState,
        version: Number(row.result_version), actor: String(row.actor_name),
        reason: row.reason == null ? null : String(row.reason),
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
      map.set(accountId, bucket);
    }
    return map;
  }

  private shape(
    row: Row, canWrite: boolean, canReveal: boolean, history: ProtectedAccountEventDto[],
  ): ProtectedAccountDto {
    const state = String(row.state) as ProtectedAccountState;
    const last4 = state === 'active' && row.last4 != null ? String(row.last4) : null;
    return {
      id: Number(row.id), purpose: String(row.purpose) as ProtectedAccountPurpose,
      targetId: Number(row.target_id), targetName: String(row.target_name),
      targetTag: row.target_tag == null ? null : String(row.target_tag), state,
      version: Number(row.row_version), last4,
      maskedAccountNumber: last4 ? `**** ${last4}` : null,
      updatedBy: String(row.updated_by_name), updatedAt: new Date(String(row.updated_at)).toISOString(),
      canUpdate: canWrite, canDelete: canWrite && state === 'active',
      canReveal: canReveal && state === 'active', events: history,
    };
  }

  private async one(
    q: DataSource | EntityManager, accountId: number, canWrite: boolean, canReveal: boolean,
  ): Promise<ProtectedAccountDto> {
    const [row] = await q.query(`${BASE_SELECT} WHERE a.id=$1`, [accountId]) as Row[];
    if (!row) {
      throw new NotFoundException({ code: 'PROTECTED_ACCOUNT_NOT_FOUND', message: '계좌를 찾을 수 없습니다' });
    }
    const history = await this.events(q, [accountId]);
    return this.shape(row, canWrite, canReveal, history.get(accountId) ?? []);
  }

  async ledger(canRead: boolean, canWrite: boolean, canReveal: boolean): Promise<ProtectedAccountLedgerDto> {
    if (!canRead) throw new ForbiddenException({ code: 'FORBIDDEN', message: '계좌를 조회할 권한이 없습니다' });
    const [rows, studentTargets, teacherTargets] = await Promise.all([
      this.ds.query(`${BASE_SELECT} ORDER BY a.purpose,a.state,a.target_id`) as Promise<Row[]>,
      this.ds.query(`SELECT s.id,s.name,${studentTagSql('s')} AS target_tag FROM stu s ORDER BY s.name,s.id`) as Promise<Row[]>,
      this.ds.query(`SELECT s.id,s.name FROM staff s WHERE s.active AND (
          s.role='teacher' OR EXISTS(SELECT 1 FROM ser se WHERE se.teacher_id=s.id)
        ) ORDER BY s.name,s.id`) as Promise<Row[]>,
    ]);
    const history = await this.events(this.ds, rows.map((row) => Number(row.id)));
    return {
      canRead, canWrite, canReveal,
      targets: [
        ...studentTargets.map((row) => ({
          purpose: 'student_refund' as const, targetId: Number(row.id), targetName: String(row.name),
          targetTag: row.target_tag == null ? null : String(row.target_tag),
        })),
        ...teacherTargets.map((row) => ({
          purpose: 'teacher_payout' as const, targetId: Number(row.id), targetName: String(row.name), targetTag: null,
        })),
      ],
      items: rows.map((row) => this.shape(row, canWrite, canReveal, history.get(Number(row.id)) ?? [])),
    };
  }

  private normalize(dto: ProtectedAccountWriteDto): {
    bank: string; accountNumber: string; holder: string; last4: string;
  } {
    const bank = dto.bank.trim();
    const holder = dto.holder.trim();
    const accountNumber = dto.accountNumber.replace(/[\s-]/g, '');
    if (!bank || !holder) {
      throw new BadRequestException({ code: 'PROTECTED_ACCOUNT_REQUIRED', message: '은행과 예금주를 입력해 주세요' });
    }
    if (!/^[0-9]{4,30}$/.test(accountNumber)) {
      throw new BadRequestException({
        code: 'PROTECTED_ACCOUNT_NUMBER_INVALID', message: '계좌번호는 숫자 4~30자리로 입력해 주세요',
      });
    }
    return { bank, accountNumber, holder, last4: accountNumber.slice(-4) };
  }

  private async assertTarget(m: EntityManager, purpose: ProtectedAccountPurpose, targetId: number): Promise<void> {
    const [target] = purpose === 'student_refund'
      ? await m.query(`SELECT id FROM stu WHERE id=$1`, [targetId]) as Row[]
      : await m.query(`SELECT s.id FROM staff s WHERE s.id=$1 AND s.active AND (
          s.role='teacher' OR EXISTS(SELECT 1 FROM ser se WHERE se.teacher_id=s.id)
        )`, [targetId]) as Row[];
    if (!target) {
      throw new NotFoundException({
        code: purpose === 'student_refund' ? 'PROTECTED_ACCOUNT_STUDENT_NOT_FOUND' : 'PROTECTED_ACCOUNT_TEACHER_NOT_FOUND',
        message: purpose === 'student_refund' ? '학생을 찾을 수 없습니다' : '지급 대상 강사를 찾을 수 없습니다',
      });
    }
  }

  private async requestReplay(
    m: EntityManager, requestKey: string, actorId: number, action: AccountAction | readonly AccountAction[], fingerprint: string,
    canWrite: boolean, canReveal: boolean,
  ): Promise<{ accountId: number; version: number } | null> {
    const [prior] = await m.query(`SELECT account_id,actor_id,action,payload_sha256,result_version
      FROM protected_account_request WHERE request_key=$1`, [requestKey]) as Row[];
    if (!prior) return null;
    const allowedActions = Array.isArray(action) ? action : [action];
    if (Number(prior.actor_id) !== actorId
      || !allowedActions.includes(String(prior.action) as AccountAction)
      || String(prior.payload_sha256) !== fingerprint) {
      throw new ConflictException({
        code: 'PROTECTED_ACCOUNT_KEY_REUSED', message: '같은 계좌 요청 키를 다른 작업에 다시 사용할 수 없습니다',
      });
    }
    const accountId = Number(prior.account_id);
    const item = await this.one(m, accountId, canWrite, canReveal);
    if (item.version !== Number(prior.result_version)) {
      throw new ConflictException({
        code: 'PROTECTED_ACCOUNT_REPLAY_STALE', message: '재시도한 요청 뒤에 계좌 상태가 바뀌었습니다 — 최신 목록을 확인하세요',
      });
    }
    return { accountId, version: item.version };
  }

  async write(
    actorId: number, canWrite: boolean, canReveal: boolean, dto: ProtectedAccountWriteDto,
  ): Promise<ProtectedAccountWriteResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '계좌를 저장할 권한이 없습니다' });
    const secret = this.normalize(dto);
    const fingerprint = sha({
      purpose: dto.purpose, targetId: dto.targetId, bank: secret.bank,
      accountNumber: secret.accountNumber, holder: secret.holder, expectedVersion: dto.expectedVersion,
    });
    return this.ds.transaction(async (m) => {
      await this.lockRequestKey(m, dto.requestKey);
      const replay = await this.requestReplay(
        m, dto.requestKey, actorId, ['created', 'updated'], fingerprint, canWrite, canReveal,
      );
      if (replay) return { item: await this.one(m, replay.accountId, canWrite, canReveal), replayed: true };
      await this.assertTarget(m, dto.purpose, dto.targetId);
      const [current] = await m.query(`SELECT id,state,row_version FROM protected_account
        WHERE purpose=$1 AND target_id=$2 FOR UPDATE`, [dto.purpose, dto.targetId]) as Row[];
      const actualVersion = current ? Number(current.row_version) : 0;
      if (dto.expectedVersion !== actualVersion) {
        throw new ConflictException({
          code: 'PROTECTED_ACCOUNT_STALE', message: '다른 계좌 변경이 있습니다 — 최신 목록을 확인하세요',
          expectedVersion: dto.expectedVersion, actualVersion,
        });
      }
      const action: AccountAction = current ? 'updated' : 'created';
      const nextVersion = actualVersion + 1;
      // 정확한 멱등 재시도는 위에서 저장 결과로 수렴한다. 새 쓰기만 활성 키가 필요하며,
      // 키가 없거나 잘못되면 current/request/event 어느 것도 쓰기 전에 fail-closed한다.
      const sealed = sealProtectedAccount({ bank: secret.bank, accountNumber: secret.accountNumber, holder: secret.holder });
      let accountId: number;
      if (!current) {
        const [made] = await m.query(`INSERT INTO protected_account(
            purpose,target_id,state,row_version,ciphertext,key_version,last4,created_by,updated_by)
          VALUES($1,$2,'active',1,$3,$4,$5,$6,$6) RETURNING id`, [
          dto.purpose, dto.targetId, sealed.ciphertext, sealed.keyVersion, secret.last4, actorId,
        ]) as Row[];
        accountId = Number(made.id);
      } else {
        accountId = Number(current.id);
        await m.query(`UPDATE protected_account SET state='active',row_version=$2,ciphertext=$3,key_version=$4,last4=$5,
            updated_by=$6,updated_at=now(),deleted_by=NULL,deleted_at=NULL,delete_reason=NULL WHERE id=$1`, [
          accountId, nextVersion, sealed.ciphertext, sealed.keyVersion, secret.last4, actorId,
        ]);
      }
      await m.query(`INSERT INTO protected_account_request(
          request_key,account_id,actor_id,action,purpose,target_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        dto.requestKey, accountId, actorId, action, dto.purpose, dto.targetId,
        dto.expectedVersion, fingerprint, nextVersion,
      ]);
      await m.query(`INSERT INTO protected_account_event(
          account_id,action,from_state,to_state,actor_id,request_key,result_version)
        VALUES($1,$2,$3,'active',$4,$5,$6)`, [
        accountId, action, current ? current.state : null, actorId, dto.requestKey, nextVersion,
      ]);
      // 권고안: LOG에는 계좌 원문·ciphertext·은행·예금주를 넣지 않는다. 식별자·상태·뒤4자리만 남긴다.
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,after)
        VALUES($1,'PROTECTED_ACCOUNT',$2,$3,$4::jsonb)`, [actorId, accountId, action, JSON.stringify({
        purpose: dto.purpose, targetId: dto.targetId, state: 'active', version: nextVersion, last4: secret.last4,
      })]);
      return { item: await this.one(m, accountId, canWrite, canReveal), replayed: false };
    });
  }

  async remove(
    actorId: number, canWrite: boolean, canReveal: boolean, accountId: number, dto: ProtectedAccountActionDto,
  ): Promise<ProtectedAccountWriteResultDto> {
    if (!canWrite) throw new ForbiddenException({ code: 'FORBIDDEN', message: '계좌를 삭제할 권한이 없습니다' });
    const reason = dto.reason.trim();
    const fingerprint = sha({ accountId, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await this.lockRequestKey(m, dto.requestKey);
      const replay = await this.requestReplay(m, dto.requestKey, actorId, 'deleted', fingerprint, canWrite, canReveal);
      if (replay) return { item: await this.one(m, replay.accountId, canWrite, canReveal), replayed: true };
      const [current] = await m.query(`SELECT id,purpose,target_id,state,row_version FROM protected_account
        WHERE id=$1 FOR UPDATE`, [accountId]) as Row[];
      if (!current) throw new NotFoundException({ code: 'PROTECTED_ACCOUNT_NOT_FOUND', message: '계좌를 찾을 수 없습니다' });
      const actualVersion = Number(current.row_version);
      if (dto.expectedVersion !== actualVersion) {
        throw new ConflictException({
          code: 'PROTECTED_ACCOUNT_STALE', message: '다른 계좌 변경이 있습니다 — 최신 목록을 확인하세요',
          expectedVersion: dto.expectedVersion, actualVersion,
        });
      }
      if (String(current.state) !== 'active') {
        throw new ConflictException({ code: 'PROTECTED_ACCOUNT_ALREADY_DELETED', message: '이미 삭제한 계좌입니다' });
      }
      const nextVersion = actualVersion + 1;
      await m.query(`UPDATE protected_account SET state='deleted',row_version=$2,ciphertext=NULL,key_version=NULL,last4=NULL,
          updated_by=$3,updated_at=now(),deleted_by=$3,deleted_at=now(),delete_reason=$4 WHERE id=$1`, [
        accountId, nextVersion, actorId, reason,
      ]);
      await m.query(`INSERT INTO protected_account_request(
          request_key,account_id,actor_id,action,purpose,target_id,expected_version,payload_sha256,result_version)
        VALUES($1,$2,$3,'deleted',$4,$5,$6,$7,$8)`, [
        dto.requestKey, accountId, actorId, current.purpose, current.target_id,
        dto.expectedVersion, fingerprint, nextVersion,
      ]);
      await m.query(`INSERT INTO protected_account_event(
          account_id,action,from_state,to_state,actor_id,request_key,result_version,reason)
        VALUES($1,'deleted','active','deleted',$2,$3,$4,$5)`, [
        accountId, actorId, dto.requestKey, nextVersion, reason,
      ]);
      await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'PROTECTED_ACCOUNT',$2,'deleted',$3::jsonb,$4::jsonb)`, [
        actorId, accountId, JSON.stringify({ state: 'active', version: actualVersion }),
        JSON.stringify({ state: 'deleted', version: nextVersion, reason }),
      ]);
      return { item: await this.one(m, accountId, canWrite, canReveal), replayed: false };
    });
  }

  async reveal(
    actorId: number, canWrite: boolean, canReveal: boolean, accountId: number, dto: ProtectedAccountActionDto,
  ): Promise<ProtectedAccountSecretDto> {
    if (!canReveal) throw new ForbiddenException({ code: 'FORBIDDEN', message: '계좌 원문을 확인할 권한이 없습니다' });
    const reason = dto.reason.trim();
    const fingerprint = sha({ accountId, expectedVersion: dto.expectedVersion, reason });
    return this.ds.transaction(async (m) => {
      await this.lockRequestKey(m, dto.requestKey);
      const replay = await this.requestReplay(m, dto.requestKey, actorId, 'revealed', fingerprint, canWrite, canReveal);
      const [current] = await m.query(`${BASE_SELECT} WHERE a.id=$1 FOR UPDATE OF a`, [accountId]) as Row[];
      if (!current) throw new NotFoundException({ code: 'PROTECTED_ACCOUNT_NOT_FOUND', message: '계좌를 찾을 수 없습니다' });
      const actualVersion = Number(current.row_version);
      if (dto.expectedVersion !== actualVersion || (replay && replay.version !== actualVersion)) {
        throw new ConflictException({
          code: 'PROTECTED_ACCOUNT_STALE', message: '다른 계좌 변경이 있습니다 — 최신 목록을 확인하세요',
          expectedVersion: dto.expectedVersion, actualVersion,
        });
      }
      if (String(current.state) !== 'active' || !Buffer.isBuffer(current.ciphertext) || current.key_version == null) {
        throw new ConflictException({ code: 'PROTECTED_ACCOUNT_DELETED', message: '삭제한 계좌의 원문은 확인할 수 없습니다' });
      }
      const secret = openProtectedAccount(current.ciphertext as Buffer, String(current.key_version));
      if (!replay) {
        await m.query(`INSERT INTO protected_account_request(
            request_key,account_id,actor_id,action,purpose,target_id,expected_version,payload_sha256,result_version)
          VALUES($1,$2,$3,'revealed',$4,$5,$6,$7,$6)`, [
          dto.requestKey, accountId, actorId, current.purpose, current.target_id, actualVersion, fingerprint,
        ]);
        await m.query(`INSERT INTO protected_account_event(
            account_id,action,from_state,to_state,actor_id,request_key,result_version,reason)
          VALUES($1,'revealed','active','active',$2,$3,$4,$5)`, [
          accountId, actorId, dto.requestKey, actualVersion, reason,
        ]);
        await m.query(`INSERT INTO log(actor_id,entity,entity_id,action,after)
          VALUES($1,'PROTECTED_ACCOUNT',$2,'revealed',$3::jsonb)`, [
          actorId, accountId, JSON.stringify({ purpose: current.purpose, targetId: Number(current.target_id), version: actualVersion, reason }),
        ]);
      }
      return {
        accountId, purpose: String(current.purpose) as ProtectedAccountPurpose,
        targetId: Number(current.target_id), targetName: String(current.target_name), version: actualVersion,
        bank: secret.bank, accountNumber: secret.accountNumber, holder: secret.holder, replayed: Boolean(replay),
      };
    });
  }
}
