/** @file-guide
 * 목적: 자격 변경과 JWT 발급이 같은 초에 일어나도 이전 Access·Refresh를 거절하는 DB 독립 회귀다.
 * 책임/재사용: 실제 AuthService·JwtService를 쓰고 STAFF 조회만 대역으로 둔다. 비밀·토큰·해시를 출력하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import { AuthService, type JwtPayload } from '../src/auth/auth.service';
import { Staff } from '../src/entities';

const accessSecret = 'r118-synthetic-access-signing-key';
const refreshSecret = 'r118-synthetic-refresh-signing-key';
const changedAt = new Date('2026-10-10T01:00:00.900Z');

describe('R118 자격 버전 JWT — DB 독립', () => {
  const priorAccessSecret = process.env.JWT_SECRET;
  const priorRefreshSecret = process.env.JWT_REFRESH_SECRET;
  let current: Staff;
  let auth: AuthService;
  let jwt: JwtService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-10T01:00:00.100Z'));
    process.env.JWT_SECRET = accessSecret;
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    current = Object.assign(new Staff(), {
      id: 1, name: '검수 계정', role: 'manager', active: true,
      canMoney: null, canWage: null, canApprove: null, canHide: null, canGpaPack: null,
      mustChangeCredentials: false, credentialsChangedAt: null,
    });
    jwt = new JwtService();
    auth = new AuthService({ findOne: jest.fn(async () => current) } as unknown as Repository<Staff>, jwt);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (priorAccessSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = priorAccessSecret;
    }
    if (priorRefreshSecret === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = priorRefreshSecret;
    }
  });

  const payloadOf = (token: string) => jwt.verify<JwtPayload>(token, { secret: accessSecret });
  const userFrom = (token: string) => {
    const payload = payloadOf(token);
    return auth.currentUser(payload.sub, payload.iat, payload.cv);
  };

  it('자격 변경 전 같은 초에 발급한 access와 refresh를 모두 거절한다', async () => {
    const old = auth.issueSession(current);
    current.credentialsChangedAt = changedAt;
    jest.setSystemTime(changedAt);
    await expect(userFrom(old.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(old.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('변경 직후 같은 초의 새 로그인 토큰은 정상 동작하고 refresh도 새 버전을 유지한다', async () => {
    current.credentialsChangedAt = changedAt;
    jest.setSystemTime(changedAt);
    const fresh = auth.issueSession(current);
    expect(payloadOf(fresh.accessToken).cv).toBe(changedAt.getTime());
    expect(jwt.verify<{ cv: number }>(fresh.refreshToken, { secret: refreshSecret }).cv).toBe(changedAt.getTime());
    await expect(userFrom(fresh.accessToken)).resolves.toMatchObject({ id: 1 });
    const renewed = await auth.refresh(fresh.refreshToken);
    await expect(userFrom(renewed.accessToken)).resolves.toMatchObject({ id: 1 });
  });

  it('reset 전에 읽은 STAFF로 reset 이후 늦게 발급한 토큰도 거절한다', async () => {
    const stale = Object.assign(new Staff(), current);
    current.credentialsChangedAt = changedAt;
    jest.setSystemTime(new Date('2026-10-10T01:00:01.100Z'));
    const delayed = auth.issueSession(stale);
    await expect(userFrom(delayed.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(delayed.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it.each([null, -1, 0.1, NaN, Infinity, '123', {}, []])('cv 형식이 잘못되면 닫힌 쪽으로 판정한다: %j', async (cv) => {
    await expect(auth.currentUser(1, Math.floor(Date.now() / 1000), cv)).rejects.toMatchObject({ status: 401 });
    const token = jwt.sign({ sub: 1, cv }, { secret: refreshSecret, expiresIn: '1m' });
    await expect(auth.refresh(token)).rejects.toMatchObject({ status: 401 });
  });

  it('legacy 토큰의 같은 초 발급은 access와 refresh 모두 거절한다', async () => {
    current.credentialsChangedAt = changedAt;
    const iat = Math.floor(changedAt.getTime() / 1000);
    await expect(auth.currentUser(1, iat)).rejects.toMatchObject({ status: 401 });
    const token = jwt.sign({ sub: 1, iat }, { secret: refreshSecret, expiresIn: '1m' });
    await expect(auth.refresh(token)).rejects.toMatchObject({ status: 401 });
  });

  it('legacy 토큰도 자격 변경 이력이 없거나 변경 다음 초 발급이면 호환된다', async () => {
    await expect(auth.currentUser(1, Math.floor(Date.now() / 1000))).resolves.toMatchObject({ id: 1 });
    current.credentialsChangedAt = changedAt;
    const iat = Math.floor(changedAt.getTime() / 1000) + 1;
    jest.setSystemTime(new Date(iat * 1000));
    await expect(auth.currentUser(1, iat)).resolves.toMatchObject({ id: 1 });
    const token = jwt.sign({ sub: 1, iat }, { secret: refreshSecret, expiresIn: '1m' });
    await expect(auth.refresh(token)).resolves.toEqual({ accessToken: expect.any(String) });
  });
});
