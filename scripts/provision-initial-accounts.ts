/** @file-guide
 * 목적: 운영 최초 CEO·manager·admin 계정을 지정 로그인 아이디와 서버 전용 초기 비밀번호로 멱등 발급한다.
 * 책임/재사용: 비밀번호를 출력·기록하지 않고 STAFF 해시와 최소 감사 영수증만 갱신한다. 일반 계정 생성은 DrawerService가 소유한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { INITIAL_PASSWORD } from '../src/lib/account-policy';

dotenv.config({ path: '.env.local' });
dotenv.config();

const APPLY = process.argv.includes('--apply');
const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) ?? null;

const BOOTSTRAP = [
  { loginId: 'minsun1234', role: 'ceo', name: null, title: '대표' },
  { loginId: 'bj1234', role: 'manager', name: '김범준', title: '매니저' },
  { loginId: 'admin1234', role: 'admin', name: '관리자', title: '관리자' },
] as const;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL이 없습니다');
  await ds.initialize();
  try {
    const [{ db, user }] = await ds.query(`SELECT current_database() AS db, current_user AS "user"`) as Array<{ db: string; user: string }>;
    const rows = await ds.query(
      `SELECT id, name, login_id, role::text AS role, active
         FROM staff
        WHERE active AND (role = 'ceo' OR lower(login_id) = ANY($1::text[]))
        ORDER BY id`,
      [BOOTSTRAP.map((account) => account.loginId)],
    ) as Array<{ id: string; name: string; login_id: string; role: string; active: boolean }>;
    const ceos = rows.filter((row) => row.role === 'ceo');
    if (ceos.length !== 1) throw new Error(`활성 CEO가 정확히 한 명이어야 합니다 (현재 ${ceos.length}명)`);
    for (const account of BOOTSTRAP.slice(1)) {
      const existing = rows.find((row) => row.login_id.toLowerCase() === account.loginId);
      if (existing && existing.role !== account.role) {
        throw new Error(`${account.loginId} 아이디가 ${existing.role} 역할에 이미 사용 중입니다`);
      }
    }

    console.log(`대상 DB: ${db} · 사용자: ${user}`);
    console.log(`계정: ${BOOTSTRAP.map((account) => `${account.loginId}(${account.role})`).join(' · ')}`);
    console.log('비밀번호: 서버 전용 TACO_INITIAL_PASSWORD/기본 초기값 사용 · 출력하지 않음');
    if (!APPLY) {
      console.log(`쓰기 0 · 적용하려면 --apply --confirm=${db}`);
      return;
    }
    if (confirm !== db) throw new Error(`--confirm=${db}가 필요합니다`);

    const hash = await bcrypt.hash(INITIAL_PASSWORD, 12);
    await ds.transaction(async (m) => {
      const ceo = ceos[0]!;
      const conflicts = await m.query(
        `SELECT id FROM staff WHERE lower(login_id) = lower($1) AND id <> $2`,
        [BOOTSTRAP[0].loginId, ceo.id],
      ) as Array<{ id: string }>;
      if (conflicts.length > 0) throw new Error(`${BOOTSTRAP[0].loginId} 아이디가 다른 계정에 이미 사용 중입니다`);
      await m.query(
        `UPDATE staff
            SET login_id=$2, password_hash=$3, active=true, must_change_credentials=false,
                credentials_changed_at=now()
          WHERE id=$1`,
        [ceo.id, BOOTSTRAP[0].loginId, hash],
      );
      for (const account of BOOTSTRAP.slice(1)) {
        const [existing] = await m.query(
          `SELECT id, role::text AS role FROM staff WHERE lower(login_id)=lower($1) FOR UPDATE`,
          [account.loginId],
        ) as Array<{ id: string; role: string }>;
        if (existing && existing.role !== account.role) throw new Error(`${account.loginId} 역할 충돌`);
        if (existing) {
          await m.query(
            `UPDATE staff
                SET password_hash=$2, active=true, must_change_credentials=false,
                    credentials_changed_at=now()
              WHERE id=$1`,
            [existing.id, hash],
          );
        } else {
          await m.query(
            `INSERT INTO staff(name,login_id,role,title,tz,password_hash,active,must_change_credentials,credentials_changed_at)
             VALUES($1,$2,$3::role_t,$4,'Asia/Seoul',$5,true,false,now())`,
            [account.name, account.loginId, account.role, account.title, hash],
          );
        }
      }
      await m.query(
        `INSERT INTO log(actor_id,entity,entity_id,action,before,after)
         VALUES($1,'STAFF',$1,'account_provision','{}'::jsonb,$2::jsonb)`,
        [ceo.id, JSON.stringify({ roles: BOOTSTRAP.map((account) => account.role), count: BOOTSTRAP.length })],
      );
    });
    console.log('초기 계정 3개 발급 완료 · 비밀번호 출력/기록 0');
  } finally {
    await ds.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(`초기 계정 발급 실패: ${(error as Error).message}`);
  process.exitCode = 1;
});
