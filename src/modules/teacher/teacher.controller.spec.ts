/** @file-guide
 * 목적: teacher.controller.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ForbiddenException } from '@nestjs/common';
import { TeacherController } from './teacher.controller';
import type { TeacherService } from './teacher.service';
import type { RequestUser } from '../../common/perm';

// DB 없는 단위 회귀 — 역할 방어와 본인 고정(위임 인자)만 본다. 집계 SQL은 격리 DB 스위트에서.
describe('TeacherController — 강사 전용 표면', () => {
  const dto = { todayDate: '2026-09-12', today: [], upcoming: [], week: { lessons: 0, minutes: 0, unwritten: 0 }, todo: { unwrittenReports: 0, waitingApprovals: 0, openChangeRequests: 0, openStaffRequests: 0 }, settings: { name: '', timezone: 'Asia/Seoul', wageRate: null, wageFrom: null } };
  const hist = { month: '2026-09', stats: {}, lessons: [], settlement: {} };
  const svc = {
    home: jest.fn().mockResolvedValue(dto),
    history: jest.fn().mockResolvedValue(hist),
    suggestions: jest.fn().mockResolvedValue({ used: 0, items: [] }),
    createSuggestion: jest.fn().mockResolvedValue({ id: 1 }),
    guides: jest.fn().mockResolvedValue({ students: [] }),
  } as unknown as TeacherService;
  const ctrl = new TeacherController(svc);
  const user = (role: RequestUser['role'], id = 7): RequestUser => ({ id, role, perms: {} } as RequestUser);

  beforeEach(() => jest.clearAllMocks());

  it('강사는 자기 id 로 고정되어 위임된다', async () => {
    await expect(ctrl.home(user('teacher', 42))).resolves.toBe(dto);
    expect((svc.home as jest.Mock).mock.calls).toEqual([[42]]);
  });

  it.each(['manager', 'admin', 'ceo'] as const)('%s 는 403 — 다른 강사 데이터를 조회할 경로가 없다', async (role) => {
    await expect(ctrl.home(user(role))).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.home).not.toHaveBeenCalled();
  });

  it('히스토리도 자기 id·요청 월로 위임된다', async () => {
    await expect(ctrl.history(user('teacher', 42), { month: '2026-08' })).resolves.toBe(hist);
    expect((svc.history as jest.Mock).mock.calls).toEqual([[42, '2026-08']]);
  });

  it('히스토리 월 생략은 undefined 로 위임 — 기본 월 판정은 서비스가 한다', async () => {
    await ctrl.history(user('teacher', 42), {});
    expect((svc.history as jest.Mock).mock.calls).toEqual([[42, undefined]]);
  });

  it.each(['manager', 'admin', 'ceo'] as const)('%s 는 히스토리(정산 포함)도 403', async (role) => {
    await expect(ctrl.history(user(role), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.history).not.toHaveBeenCalled();
  });

  it('건의 목록·등록은 자기 id 로 위임된다', async () => {
    await ctrl.suggestions(user('teacher', 42));
    expect((svc.suggestions as jest.Mock).mock.calls).toEqual([[42]]);
    const dto2 = { category: 'lesson', body: '교재 재고 확인 부탁드립니다' };
    await ctrl.createSuggestion(user('teacher', 42), dto2);
    expect((svc.createSuggestion as jest.Mock).mock.calls).toEqual([[42, dto2]]);
  });

  it('수업 안내도 자기 id·주 인자로 위임된다', async () => {
    await ctrl.guides(user('teacher', 42), { week: '2026-09-01' });
    await ctrl.guides(user('teacher', 42), {});
    expect((svc.guides as jest.Mock).mock.calls).toEqual([[42, '2026-09-01'], [42, undefined]]);
  });

  it.each(['manager', 'admin', 'ceo'] as const)('%s 는 수업 안내도 403', async (role) => {
    await expect(ctrl.guides(user(role), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.guides).not.toHaveBeenCalled();
  });

  it.each(['manager', 'admin', 'ceo'] as const)('%s 는 건의 읽기·쓰기 모두 403', async (role) => {
    await expect(ctrl.suggestions(user(role))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.createSuggestion(user(role), { category: 'etc', body: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.suggestions).not.toHaveBeenCalled();
    expect(svc.createSuggestion).not.toHaveBeenCalled();
  });
});
