/** @file-guide
 * 목적: 초기 3계정의 최초 발급과 재실행 보존을 같은 트랜잭션에서 판정한다.
 * 책임/재사용: 기존 계정의 자격·활성 상태는 보존하고 CLI 출력은 scripts/provision-initial-accounts.ts가 소유한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import * as bcrypt from 'bcryptjs';
import type { DataSource } from 'typeorm';
import { requireInitialPassword } from './account-policy';

export const INITIAL_ACCOUNTS = [
  { loginId: 'minsun1234', role: 'ceo', name: null, title: '대표' },
  { loginId: 'bj1234', role: 'manager', name: '김범준', title: '매니저' },
  { loginId: 'admin1234', role: 'admin', name: '관리자', title: '관리자' },
] as const;

export class InitialAccountProvisionError extends Error {
  constructor(readonly code: 'CONFIRM_REQUIRED' | 'ROLE_CONFLICT' | 'CEO_REQUIRED' | 'ALREADY_PROVISIONED') {
    super(code);
  }
}

export interface InitialAccountProvisionResult {
  database: string;
  user: string;
  apply: boolean;
  created: number;
  renamed: number;
  preserved: number;
}

interface AccountRow { id: string; login_id: string; role: string; active: boolean }

/**
 * R118 권고안: 초기 발급은 자격 복구/재활성화 명령이 아니다. 기존 ID의 역할이 맞으면 암호·활성·
 * 첫 설정·세션 시각을 모두 보존한다. 최초 발급 감사가 있으면 바뀐 ID를 재생성하거나 CEO를 다시 개명하지 않는다.
 * AUTH-INIT-02(사용자 결정 2026-10-16): 공통 초기 비밀번호를 쓰는 발급(CEO 개명 · 신규 두 계정)은 첫 설정 잠금을 **켠다** —
 * 역할 · 고정 로그인 ID 로 면제하지 않는다. 이미 있는 계정은 이 함수가 건드리지 않으므로(재실행 no-op) 옛 면제 행의 전환은
 * 판정 함수(AuthService.credentialSetupRequired)가 맡는다. 변경 시 계정 기능 문서·운영 복구 절차와 이 함수의 병렬/실패 원자성 시험을 함께 대조한다.
 */
export async function provisionInitialAccounts(
  ds: DataSource,
  options: { apply: boolean; confirm: string | null; initialPassword: string },
): Promise<InitialAccountProvisionResult> {
  return ds.transaction(async (m) => {
    // 두 CLI가 같은 최초 상태를 읽어 각각 암호를 덮지 않도록, 판정 전에 같은 전용 잠금을 잡는다.
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('initial-accounts-provision'))`);
    const [{ database, user }] = await m.query(
      `SELECT current_database() AS database,current_user AS "user"`,
    ) as Array<{ database: string; user: string }>;
    if (options.apply && options.confirm !== database) {
      throw new InitialAccountProvisionError('CONFIRM_REQUIRED');
    }
    const rows = await m.query(
      `SELECT id,login_id,role::text AS role,active FROM staff
        WHERE role='ceo' OR lower(login_id)=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [INITIAL_ACCOUNTS.map((account) => account.loginId)],
    ) as AccountRow[];
    const existing = INITIAL_ACCOUNTS.map((account) => {
      const found = rows.find((row) => row.login_id.toLowerCase() === account.loginId);
      // 권한 부여가 아니라 고정 초기 identity 충돌 검사다. 비활성 행도 같은 검사/보존 대상이다.
      const role = found?.role;
      const expectedRole = account.role;
      if (found && role !== expectedRole) {
        throw new InitialAccountProvisionError('ROLE_CONFLICT');
      }
      return found;
    });
    const preserved = existing.filter(Boolean).length;
    const result: InitialAccountProvisionResult = {
      database, user, apply: options.apply, created: 0, renamed: 0, preserved,
    };
    if (preserved === INITIAL_ACCOUNTS.length) {
      return result;
    }
    const [receipt] = await m.query(
      `SELECT 1 FROM log WHERE entity='STAFF' AND action='account_provision' LIMIT 1`,
    ) as Array<Record<string, unknown>>;
    if (receipt) {
      throw new InitialAccountProvisionError('ALREADY_PROVISIONED');
    }
    const activeCeos = rows.filter(({ role, active }) => role === 'ceo' && active);
    const ceo = activeCeos[0];
    if (activeCeos.length !== 1 || !ceo || (existing[0] && existing[0].id !== ceo.id)) {
      throw new InitialAccountProvisionError('CEO_REQUIRED');
    }
    result.renamed = existing[0] ? 0 : 1;
    result.created = existing.slice(1).filter((row) => !row).length;
    if (!options.apply) {
      return result;
    }
    const hash = await bcrypt.hash(requireInitialPassword(options.initialPassword), 12);
    if (result.renamed) {
      await m.query(
        `UPDATE staff SET login_id=$2,password_hash=$3,must_change_credentials=true,
          credentials_changed_at=now() WHERE id=$1`,
        [ceo.id, INITIAL_ACCOUNTS[0].loginId, hash],
      );
    }
    for (let index = 1; index < INITIAL_ACCOUNTS.length; index += 1) {
      if (existing[index]) {
        continue;
      }
      const account = INITIAL_ACCOUNTS[index];
      await m.query(
        `INSERT INTO staff(name,login_id,role,title,tz,password_hash,active,must_change_credentials,credentials_changed_at)
          VALUES($1,$2,$3::role_t,$4,'Asia/Seoul',$5,true,true,now())`,
        [account.name, account.loginId, account.role, account.title, hash],
      );
    }
    await m.query(
      `INSERT INTO log(actor_id,entity,entity_id,action,before,after)
        VALUES($1,'STAFF',$1,'account_provision','{}'::jsonb,$2::jsonb)`,
      [ceo.id, JSON.stringify({ roles: INITIAL_ACCOUNTS.map((account) => account.role), count: result.created + result.renamed })],
    );
    return result;
  });
}
