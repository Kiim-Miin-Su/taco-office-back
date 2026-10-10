/** @file-guide
 * 목적: 구성원 자격 변경으로 개인별 권한 제한을 우회하지 못하는지 DB 없이 검증한다.
 * 책임/재사용: 실제 controller/service와 권한 정본을 사용하고 repository만 대역으로 둔다. 실제 DB 원자성은 HTTP 회귀가 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { EntityManager, Repository } from 'typeorm';
import type { Lead } from '../../entities';
import { PERM_OVERRIDE_KEYS, type RequestUser } from '../../common/perm';
import type { ScheduleService } from '../schedule/schedule.service';
import { DrawerController } from './drawer.controller';
import type { StaffPatchDto } from './drawer.dto';
import { DrawerService } from './drawer.service';

const target = {
  id: '200', name: '검수 계정', login_id: 'audit-target', email: null, phone: null,
  role: 'manager', title: '매니저', tz: 'Asia/Seoul', active: true, manageable: true,
  must_change_credentials: false, hired_on: '2026-10-10', wageable: false,
  can_money: null, can_wage: null, can_approve: null, can_hide: null, can_gpa_pack: null,
};
const actor: RequestUser = { id: 100, name: '검수 담당자', role: 'manager', perms: { canMoney: false } };

function setup(row: Record<string, unknown> = target) {
  const query = jest.fn(async (sql: string): Promise<Array<Record<string, unknown>>> => {
    if (sql.includes('FOR UPDATE')) {
      return [{ ...row }];
    }
    if (sql.includes('SELECT id FROM staff WHERE lower')) {
      return [];
    }
    if (sql.includes('FROM staff WHERE id = $1')) {
      return [{ ...row }];
    }
    return [];
  });
  const manager = { query };
  const transaction = jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
    work(manager as unknown as EntityManager));
  const svc = new DrawerService({ query, manager: { transaction } } as unknown as Repository<Lead>);
  const controller = new DrawerController(svc, {} as ScheduleService);
  const writes = () => query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql));
  return { controller, svc, query, writes };
}

describe('구성원 자격 변경의 권한 한도 — DB 독립', () => {
  it.each(PERM_OVERRIDE_KEYS)('%s가 없는 담당자는 더 넓은 매니저의 비밀번호를 초기화하지 못한다', async (key) => {
    const { controller, writes } = setup();
    await expect(controller.resetStaffPassword(
      { ...actor, perms: { [key]: false } }, { id: 200 }, { password: 'Audit-temp-123' },
    )).rejects.toMatchObject({ response: { code: 'PERM_GRANT_FORBIDDEN' } });
    expect(writes()).toHaveLength(0);
  });

  it.each<StaffPatchDto>([
    { loginId: 'new-audit-login' }, { email: 'audit@example.test' }, { phone: '01012345678' },
  ])('더 넓은 계정의 아이디·연락처 변경은 저장 전에 거절한다: %j', async (patch) => {
    const { controller, writes } = setup();
    await expect(controller.updateStaff(actor, { id: 200 }, patch))
      .rejects.toMatchObject({ response: { code: 'PERM_GRANT_FORBIDDEN' } });
    expect(writes()).toHaveLength(0);
  });

  it('시급 권한을 숨겨 가진 강사 계정에도 역할 이름이 아닌 실제 권한 한도를 적용한다', async () => {
    const { controller, writes } = setup({ ...target, role: 'teacher', can_wage: true });
    await expect(controller.resetStaffPassword(
      { ...actor, perms: { canWage: false } }, { id: 200 }, { password: 'Audit-temp-123' },
    )).rejects.toMatchObject({ response: { code: 'PERM_GRANT_FORBIDDEN' } });
    expect(writes()).toHaveLength(0);
  });

  it('자격과 무관한 직함 변경은 더 넓은 계정에도 기존 업무 권한을 유지한다', async () => {
    const { controller, writes } = setup();
    await expect(controller.updateStaff(actor, { id: 200 }, { title: '새 직함' })).resolves.toMatchObject({ id: 200 });
    expect(writes()).toHaveLength(2);
  });

  it('같은 아이디를 다시 보낸 프로필 수정은 자격 변경으로 오인하지 않는다', async () => {
    const { controller, writes } = setup();
    await expect(controller.updateStaff(actor, { id: 200 }, { loginId: target.login_id, title: '새 직함' }))
      .resolves.toMatchObject({ id: 200 });
    expect(writes()).toHaveLength(2);
  });

  it.each(['manager', 'admin', 'ceo'])('권한이 충분한 %s는 기존 매니저 초기화를 수행한다', async (role) => {
    const { controller, writes } = setup();
    await expect(controller.resetStaffPassword(
      { ...actor, role, perms: null }, { id: 200 }, { password: 'Audit-temp-123' },
    )).resolves.toMatchObject({ id: 200 });
    expect(writes()).toHaveLength(2);
  });

  it('같은 권한으로 제한된 대상의 자격 변경은 허용한다', async () => {
    const { controller, writes } = setup({ ...target, can_money: false });
    await expect(controller.updateStaff(actor, { id: 200 }, { email: 'audit@example.test' }))
      .resolves.toMatchObject({ id: 200 });
    expect(writes()).toHaveLength(2);
  });

  it('서비스 직접 호출에서 actor 권한이 없으면 초기화를 허용하지 않는다', async () => {
    const { svc, writes } = setup();
    await expect(svc.resetStaffPassword(100, false, 200, 'Audit-temp-123'))
      .rejects.toMatchObject({ response: { code: 'PERM_GRANT_FORBIDDEN' } });
    expect(writes()).toHaveLength(0);
  });
});
