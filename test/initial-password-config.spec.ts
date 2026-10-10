/** @file-guide
 * 목적: 초기 비밀번호 설정 누락·불완전 상태에서 비밀번호 쓰기만 거절하고 기존 로그인·조회는 보존하는지 검증한다.
 * 책임/재사용: 실제 공용 정책·서비스·운영 전환 함수를 호출하고 DB와 발송은 대역으로 둔다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/OPS-RISK-AUDIT-R118-2026-10-10.md
 */
import type { DataSource, Repository } from 'typeorm';
import type { Lead, Staff as StaffEntity } from '../src/entities';
import type { Sender } from '../src/modules/notify/sender';

describe('서버 전용 초기 비밀번호 설정', () => {
  const before = process.env.TACO_INITIAL_PASSWORD;
  afterEach(() => {
    if (before === undefined) {
      delete process.env.TACO_INITIAL_PASSWORD;
    } else {
      process.env.TACO_INITIAL_PASSWORD = before;
    }
    jest.resetModules();
  });

  it.each(['', 'short1', 'no-digits-here', 'x1'.repeat(40)])('설정이 없거나 정책에 어긋나면 거절한다 (%#)', async (value) => {
    const { requireInitialPassword } = await import('../src/lib/account-policy');
    expect(() => requireInitialPassword(value)).toThrow('INITIAL_PASSWORD_REQUIRED');
  });

  it('설정이 없으면 기본 비밀번호를 만들지 않으며 운영 전환은 DB에 접근하지 않는다', async () => {
    delete process.env.TACO_INITIAL_PASSWORD;
    jest.resetModules();
    const { INITIAL_PASSWORD } = await import('../src/lib/account-policy');
    const { applyGoLive } = await import('../src/lib/golive-reset');
    const query = jest.fn();
    expect(INITIAL_PASSWORD).toBe('');
    await expect(applyGoLive({ query }, 'synthetic@example.test')).rejects.toThrow('INITIAL_PASSWORD_REQUIRED');
    expect(query).not.toHaveBeenCalled();
  });

  it('명시적으로 전달한 합성 자격은 그대로 사용한다', async () => {
    const { requireInitialPassword } = await import('../src/lib/account-policy');
    expect(requireInitialPassword('configured-fixture-1234!')).toBe('configured-fixture-1234!');
  });

  it.each([undefined, '', 'short1', 'no-digits-here', 'x1'.repeat(40)])(
    '설정 누락·불완전 시 공용 비밀번호 정책은 비밀값 없이 503으로 거절한다 (%#)', async (value) => {
      if (value === undefined) {
        delete process.env.TACO_INITIAL_PASSWORD;
      } else {
        process.env.TACO_INITIAL_PASSWORD = value;
      }
      jest.resetModules();
      const { passwordIssue } = await import('../src/lib/account-policy');
      let failure: unknown;
      try {
        passwordIssue('new-fixture-1234!');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        status: 503,
        response: {
          code: 'INITIAL_PASSWORD_REQUIRED',
          message: '비밀번호 정책 설정을 확인할 수 없습니다 — 관리자에게 알려 주세요',
        },
      });
      expect(JSON.stringify(failure)).not.toContain('new-fixture-1234!');
      if (value) {
        expect(JSON.stringify(failure)).not.toContain(value);
      }
    },
  );

  it('설정이 유효하면 기존 비밀번호 정책을 그대로 적용한다', async () => {
    process.env.TACO_INITIAL_PASSWORD = 'configured-fixture-1234!';
    jest.resetModules();
    const { passwordIssue } = await import('../src/lib/account-policy');
    expect(passwordIssue('configured-fixture-1234!')).toBe('SAME_AS_INITIAL');
    expect(passwordIssue('new-fixture-1234!')).toBeNull();
    expect(passwordIssue('short1')).toBe('TOO_SHORT');
    expect(passwordIssue('no-digits-here')).toBe('NEEDS_LETTER_AND_DIGIT');
    expect(passwordIssue('x1'.repeat(40))).toBe('TOO_LONG');
  });

  it('설정이 없으면 생성·관리자 초기화·첫 설정·비밀번호 찾기는 쓰기와 발송 전에 거절한다', async () => {
    delete process.env.TACO_INITIAL_PASSWORD;
    jest.resetModules();
    const { DrawerService } = await import('../src/modules/drawer/drawer.service');
    const { OnboardingService } = await import('../src/auth/onboarding.service');
    const { PasswordResetService } = await import('../src/auth/password-reset.service');
    const { AuthService } = await import('../src/auth/auth.service');
    const { JwtService } = await import('@nestjs/jwt');
    const { permsOf } = await import('../src/common/perm');
    const query = jest.fn(async (_sql: string) => [{ must: true, password_hash: null }]);
    const transaction = jest.fn();
    const ds = { query, transaction } as unknown as DataSource;
    const repository = {} as Repository<StaffEntity>;
    const auth = new AuthService(repository, new JwtService());
    const sender: Sender = { ready: jest.fn(() => false), send: jest.fn() };
    const drawer = new DrawerService({ query, manager: { transaction } } as unknown as Repository<Lead>);
    const onboarding = new OnboardingService(ds, repository, auth, sender);
    const reset = new PasswordResetService(ds, sender);
    const failure = { status: 503, response: { code: 'INITIAL_PASSWORD_REQUIRED' } };
    await expect(drawer.createStaff(1, true, {
      name: '검수 강사', loginId: 'audit.teacher', password: 'new-fixture-1234!', role: 'teacher',
    }, permsOf('manager'))).rejects.toMatchObject(failure);
    await expect(drawer.resetStaffPassword(1, true, 2, 'new-fixture-1234!', permsOf('manager')))
      .rejects.toMatchObject(failure);
    await expect(onboarding.complete(2, {
      email: 'audit@example.test', phone: '01012345678', password: 'new-fixture-1234!',
      emailCode: '123456', phoneCode: '123456',
    })).rejects.toMatchObject(failure);
    await expect(reset.complete({
      loginId: 'audit.teacher', password: 'new-fixture-1234!', emailCode: '123456', phoneCode: '123456',
    })).rejects.toMatchObject(failure);
    expect(transaction).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toHaveLength(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('설정이 없어도 저장된 해시 로그인·현재 사용자·내 정보 조회는 유지한다', async () => {
    delete process.env.TACO_INITIAL_PASSWORD;
    jest.resetModules();
    const { AuthService } = await import('../src/auth/auth.service');
    const { Staff } = await import('../src/entities');
    const { JwtService } = await import('@nestjs/jwt');
    const { hash } = await import('bcryptjs');
    const current = Object.assign(new Staff(), {
      id: 1, name: '검수 계정', role: 'manager', active: true, mustChangeCredentials: false,
      credentialsChangedAt: null, passwordHash: await hash('existing-fixture-1234!', 4),
    });
    const auth = new AuthService({
      find: jest.fn(async () => [current]), findOne: jest.fn(async () => current),
    } as unknown as Repository<StaffEntity>, new JwtService());
    await expect(auth.login('audit.manager', 'existing-fixture-1234!')).resolves.toMatchObject({ user: { id: 1 } });
    await expect(auth.currentUser(1, undefined, 0)).resolves.toMatchObject({ id: 1 });
    await expect(auth.me(1)).resolves.toMatchObject({ id: 1 });
  });
});
