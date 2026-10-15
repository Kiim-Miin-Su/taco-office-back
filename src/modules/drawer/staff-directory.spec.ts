/** @file-guide
 * 목적: staff-directory.spec.ts — 관리자 강사 조회의 페이지·권한 메타데이터·개인정보 가림 회귀.
 * 책임/재사용: DTO/서비스의 읽기 projection만 검증하며 실제 DB 이력 범위는 DB QA에서 별도로 확인한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import type { Repository } from 'typeorm';
import type { Lead } from '../../entities';
import { PERM_KEY } from '../../common/perm/perm.decorator';
import { todayKst } from '../../lib/kst';
import { serStuOn } from '../../lib/sql';
import { DrawerController } from './drawer.controller';
import { DrawerService } from './drawer.service';

const staff = {
  id: '42', name: '테스트 강사', email: 'teacher@example.test', phone: '01012345678',
  title: '강사', tz: 'Asia/Seoul', active: true, hired_on: '2026-09-01', created_at: '2026-09-01T09:00:00+09:00',
};

describe('관리자 강사 목록·상세 — 기존 데이터의 안전한 조회', () => {
  it('두 조회 경로 모두 관리자+전체 CRUD 권한이 필요하다', () => {
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffDirectory)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffDirectoryDetail)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffTeacherHome)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffTeacherGuides)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffTeacherSuggestions)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffTeacherHistory)).toEqual(['canAdminPage', 'canCrudAll']);
    expect(Reflect.getMetadata(PERM_KEY, DrawerController.prototype.staffTeacherInbox)).toEqual(['canAdminPage', 'canCrudAll']);
  });

  it('등록 시각 DESC/id DESC로 10건 페이지를 요청하고 결과에 민감정보를 넣지 않는다', async () => {
    const query = jest.fn().mockResolvedValue([{
      total: '21', id: '42', name: staff.name, title: staff.title, active: true, hired_on: staff.hired_on, created_at: staff.created_at,
    }]);
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    const result = await svc.staffDirectory({ page: 2, state: 'active', search: '테스트' });
    expect(result).toMatchObject({ page: 2, pageSize: 10, total: 21, items: [{ id: 42, englishName: null }] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('ORDER BY s.created_at DESC, s.id DESC LIMIT $3 OFFSET $4');
    expect(query.mock.calls[0][0]).toContain("s.role = 'teacher' OR EXISTS");
    expect(query.mock.calls[0][1]).toEqual(['active', '테스트', 10, 10]);
    expect(JSON.stringify(result)).not.toContain(staff.email);
    expect(JSON.stringify(result)).not.toContain(staff.phone);
  });

  it('실제 수업 담당자를 targetStaff로 검증하고 기존 강사 읽기 계산을 관리자 facade에서 재사용한다', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT s.id FROM staff s')) return [{ id: '42' }];
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const teacher = {
      home: jest.fn().mockResolvedValue({
        todayDate: '2026-10-09', today: [], upcoming: [], todaySummary: { lessons: 0, minutes: 0 },
        week: { lessons: 0, minutes: 0, unwritten: 0 },
        todo: { unwrittenReports: 0, waitingApprovals: 0, openChangeRequests: 0, openStaffRequests: 0, openBookChanges: 0 },
        settings: {
          name: '실장 강사', timezone: 'Asia/Seoul', wageRate: 50000, wageFrom: '2026-10-01', timezones: [],
          kinderHourlyRate: 60000, diagPerSession: 15000, mockPerSession: 15000,
          requests: [{ id: 9, reqType: 'wage_change', label: '시급 변경', asked: '60,000원/시간', state: 'pending', createdOn: '2026-10-09', rejectReason: null }],
          canAskWage: false, wageAskableOn: '2026-11-01', canAskTz: true,
        },
      }),
      guides: jest.fn().mockResolvedValue({ weekFrom: '2026-10-05', weekTo: '2026-10-11', students: [] }),
      suggestions: jest.fn().mockResolvedValue({ yearMonth: '2026-10', used: 1, limit: 3, remaining: 2, canPost: true, items: [] }),
      history: jest.fn().mockResolvedValue({
        month: '2026-09', stats: { doneCount: 1, doneMinutes: 60, writtenCount: 1, writtenMinutes: 60, unwrittenCount: 0, unwrittenMinutes: 0 },
        wageRate: 50000, wageFrom: '2026-10-01',
        lessons: [{
          serId: 3, onDate: '2026-09-30', date: '2026-09-30', startMin: 600, durMin: 60,
          kindKey: 'class', subKey: 'writing', mode: 'offline', title: 'Writing', students: '학생A',
          studentItems: [{ id: 31, name: '학생A' }], studentCount: 1, repState: 'ok', canceled: false,
          submittedAt: '2026-09-30 11:10', pay: 50000, lateCut: 5000, penaltyIfNow: null, bonus: 10000,
          settle: 'written', settleLabel: '리포트 씀', correctionOf: null, paidIn: null, frozen: false,
        }],
        settlement: { yearMonth: '2026-09', net: 52000 },
        bonusRules: [{ label: 'Kinder', hint: '시간 가산', amount: 10000, applied: true, note: null }],
      }),
    };
    const svc = new DrawerService(
      { query } as unknown as Repository<Lead>, undefined, undefined, teacher as never,
    );
    const home = await svc.staffTeacherHome(42, 2, false, false);
    expect(teacher.home).toHaveBeenCalledWith(42);
    // AUTH-SELF-01 파생 단가(Kinder 시급은 기본 시급을 담는다)도 같은 가림을 따른다
    expect(home.settings).toMatchObject({
      wageRate: null, wageFrom: null, kinderHourlyRate: null, diagPerSession: null, mockPerSession: null, requests: [{ asked: null }],
    });
    await expect(svc.staffTeacherGuides(42, '2026-10-09')).resolves.toMatchObject({ weekFrom: '2026-10-05' });
    await expect(svc.staffTeacherSuggestions(42)).resolves.toMatchObject({ used: 1, remaining: 2 });
    expect(teacher.guides).toHaveBeenCalledWith(42, '2026-10-09');
    expect(teacher.suggestions).toHaveBeenCalledWith(42);
    const history = await svc.staffTeacherHistory(42, 2, false, false, '2026-09');
    expect(teacher.history).toHaveBeenCalledWith(42, '2026-09');
    expect(history).toMatchObject({
      month: '2026-09', wageAccess: false, wageRate: null, wageFrom: null, settlement: null,
      lessons: [{ pay: null, lateCut: null, penaltyIfNow: null, bonus: null, settleLabel: '리포트 씀' }],
      bonusRules: [{ label: 'Kinder', amount: null }],
    });
  });

  it('강사별 들어온 것은 원문 8종만 targetStaff로 묶고 실제 actor 권한으로 시급 값을 가린다', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT s.id FROM staff s')) return [{ id: '42' }];
      if (sql.includes('FROM unav u')) return [{
        id: '91', on_date: '2026-10-18', start_min: 600, end_min: 660,
        reason: '병원 진료', at: '2026-10-08T09:00:00+09:00',
      }];
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    jest.spyOn(svc as never, 'approvalRows' as never).mockResolvedValue([
      { kind: 'rep', id: 1, title: '리포트', sub: null, byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/reports' },
      { kind: 'chreq', id: 2, title: '스케줄 변경', sub: '10:00 → 11:00', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/schedule', applicable: true },
      { kind: 'req', id: 3, title: '교재 변경', sub: 'Book A', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/books', reqType: 'book_change' },
      { kind: 'matreq', id: 4, title: '자료 요청', sub: '학생A', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/books' },
      { kind: 'req', id: 5, title: '시간대 변경', sub: '서울 → 뉴욕', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/ops', reqType: 'tz_change' },
      { kind: 'req', id: 6, title: '시급 변경', sub: '50,000원 → 60,000원', asked: '50,000원 → 60,000원', reason: '민감한 협상 사유', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/ops', reqType: 'wage_change' },
      { kind: 'suggestion', id: 7, title: '건의 사항', sub: '일정 확인', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/ops', applicable: false },
      { kind: 'req', id: 8, title: '퇴역 GPA', sub: '노출 금지', byId: 42, byName: '테스트 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/gpa', reqType: 'gpa_request' },
      { kind: 'req', id: 9, title: '다른 강사', sub: null, byId: 43, byName: '다른 강사', at: '2026-10-09', state: 'waiting', why: null, go: '/ops', reqType: 'book_change' },
    ] as never);

    const result = await svc.staffTeacherInbox(42, 2, true, true, false, false, 'all', false);
    expect(result.categories.map((item) => item.key)).toEqual([
      'report', 'schedule_change', 'book_change', 'unavailable', 'material_request', 'tz_change', 'wage_change', 'suggestion',
    ]);
    expect(result.items).toHaveLength(8);
    expect(result.items.every((item) => item.byId === 42)).toBe(true);
    expect(result.items.some((item) => item.title.includes('GPA') || item.title === '다른 강사')).toBe(false);
    expect(result.items.find((item) => item.category === 'wage_change')).toMatchObject({
      sub: null, asked: null, reason: null, canAct: false,
    });
    expect(result.items.find((item) => item.category === 'unavailable')).toMatchObject({
      sourceKind: 'unav', title: '불가 시간 · 10:00–11:00', state: 'waiting', canAct: false,
    });
  });

  it('빈 페이지도 단일 스냅숏 total을 돌려준다', async () => {
    const query = jest.fn().mockResolvedValue([{ total: '21', id: null }]);
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    await expect(svc.staffDirectory({ page: 100 })).resolves.toMatchObject({ total: 21, items: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('시급 권한이 없으면 시급·정산·비공개 설정을 읽지 않고 감사 원문을 반환하지 않는다', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM staff s WHERE s.id')) return [staff];
      if (sql.includes('FROM ser s JOIN kind')) return [];
      if (sql.includes('FROM rep r JOIN ser')) return [];
      if (sql.includes('FROM log l LEFT JOIN staff')) return [{
        id: '12', action: 'update', actor_name: '관리자', at: '2026-09-02T10:00:00+09:00',
        before: { email: 'old@example.test', phone: '01099998888', wageRate: 123456, name: '옛 이름', secretFutureField: 'PRIVATE', constructor: 'TRICK' },
        after: { email: staff.email, phone: staff.phone, wageRate: 234567, name: staff.name, secretFutureField: 'SECRET', constructor: 'TRICK_AFTER' },
      }];
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    const result = await svc.staffDirectoryDetail(42, 1, false, false);
    expect(result.wageAccess).toBe(false);
    expect(result.wages).toEqual([]);
    expect(result.payouts).toEqual([]);
    expect(result.audit[0]).toMatchObject({
      actorName: '관리자', changes: [{ field: '이름', before: '옛 이름', after: staff.name }],
      privateFields: expect.arrayContaining(['이메일', '연락처', '급여', '기타 변경']),
    });
    const auditResponse = JSON.stringify(result.audit);
    for (const privateValue of ['old@example.test', staff.email, '01099998888', staff.phone, '123456', '234567', 'PRIVATE', 'SECRET', 'TRICK', 'TRICK_AFTER']) {
      expect(auditResponse).not.toContain(privateValue);
    }
    expect(query.mock.calls.some(([sql]: [string]) => /\bFROM wage\b|\bFROM payout\b|\bFROM acct_privacy\b/.test(sql))).toBe(false);
  });

  it('비공개 시급 설정이 켜졌고 canHide가 없으면 시급·실지급액과 사유를 가린다', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM staff s WHERE s.id')) return [staff];
      if (sql.includes('FROM acct_privacy a')) return [{ key: 'wage', private: true, set_by_name: '대표', set_at: '2026-09-02' }];
      if (sql.includes('FROM wage w')) return [{ id: '3', rate: 45000, reason: '민감한 사유', from_date: '2026-09-02', approved_by_name: '대표', created_at: staff.created_at }];
      if (sql.includes('FROM payout p')) return [{ id: '4', year_month: '2026-09', state: 'confirmed', net: 900000, confirmed_by_name: '대표', confirmed_at: staff.created_at }];
      if (sql.includes('FROM ser s JOIN kind') || sql.includes('FROM rep r JOIN ser') || sql.includes('FROM log l LEFT JOIN staff')) return [];
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    const result = await svc.staffDirectoryDetail(42, 1, true, false);
    expect(result.wages).toMatchObject([{ rate: null, reason: null, fromDate: '2026-09-02' }]);
    expect(result.payouts).toMatchObject([{ net: null, yearMonth: '2026-09' }]);
  });

  it('현재 배정은 KST 오늘 시작 전·종료 후 규칙을 빼고 오늘 명단만 조회한다', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM staff s WHERE s.id')) return [staff];
      if (sql.includes('FROM ser s JOIN kind')) return [{
        id: '7', kind_name: '수업', subject_name: '수학', student_names: ['현재 학생'],
        from_date: '2026-09-01', to_date: null,
      }];
      if (sql.includes('FROM rep r JOIN ser') || sql.includes('FROM log l LEFT JOIN staff')) return [];
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    const result = await svc.staffDirectoryDetail(42, 1, false, false);
    const [sql, params] = query.mock.calls.find(([statement]: [string]) => statement.includes('FROM ser s JOIN kind'))!;
    expect(sql).toContain('AND s.from_date <= $2::date');
    expect(sql).toContain('AND (s.to_date IS NULL OR s.to_date >= $2::date)');
    expect(sql).toContain(serStuOn('ss', '$2::date'));
    expect(params).toEqual([42, todayKst()]);
    expect(result.assignments).toMatchObject([{ id: 7, studentNames: ['현재 학생'], toDate: null }]);
  });

  it('감사 이력의 at+id 복합 커서는 동일 시각·백필 행의 안정 정렬을 유지한다', async () => {
    const logs = Array.from({ length: 51 }, (_, index) => ({
      id: String(300 - index), action: 'update', actor_name: '관리자', at: '2026-09-30T10:00:00+09:00',
      cursor_at: index === 49 ? '2026-09-30T00:00:00.123456Z' : '2026-09-30T00:00:00.123457Z',
      before: {}, after: { title: '강사' },
    }));
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM staff s WHERE s.id')) return [staff];
      if (sql.includes('FROM ser s JOIN kind') || sql.includes('FROM rep r JOIN ser')) return [];
      if (sql.includes('FROM log l LEFT JOIN staff')) return logs;
      throw new Error(`예상하지 않은 조회: ${sql}`);
    });
    const svc = new DrawerService({ query } as unknown as Repository<Lead>);
    const result = await svc.staffDirectoryDetail(42, 1, false, false);
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8')) as { t: string; i: number };
    expect(decoded).toEqual({ t: '2026-09-30T00:00:00.123456Z', i: 251 });
    expect(query.mock.calls.at(-1)![0]).toContain('(l.at, l.id) < ($2::timestamptz, $3::bigint)');
    expect(query.mock.calls.at(-1)![0]).toContain('ORDER BY l.at DESC, l.id DESC LIMIT 51');
    await svc.staffDirectoryDetail(42, 1, false, false, result.nextCursor!);
    expect(query.mock.calls.at(-1)![1]).toEqual([42, decoded.t, decoded.i]);
    await expect(svc.staffDirectoryDetail(42, 1, false, false, 'not-a-valid-cursor')).rejects.toMatchObject({
      response: { code: 'STAFF_AUDIT_CURSOR_INVALID' },
    });
    for (const t of ['2026-02-31T00:00:00.000001Z', '2025-02-29T00:00:00.000001Z', '0000-01-01T00:00:00.000001Z', '2026-13-01T00:00:00.000001Z']) {
      const malformed = Buffer.from(JSON.stringify({ t, i: 251 })).toString('base64url');
      await expect(svc.staffDirectoryDetail(42, 1, false, false, malformed)).rejects.toMatchObject({
        response: { code: 'STAFF_AUDIT_CURSOR_INVALID' },
      });
    }
  });
});
