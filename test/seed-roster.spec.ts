/** @file-guide
 * 목적: 5인 개발 시드의 계정 참조·일정·권한 정합성 회귀.
 * 책임/재사용: 실제 seed와 권한 SSOT를 import한다. DB 연결·운영 계정 변경은 하지 않는다.
 * 검증/작업 지침: docs/AGENT.md · docs/CLAUDE.md
 */
import * as base from '../src/seed/base';
import * as money from '../src/seed/money';
import * as ops from '../src/seed/ops';
import * as outputs from '../src/seed/outputs';
import * as people from '../src/seed/people';
import * as schedule from '../src/seed/schedule';
import { canAdminPage, canSeeProfit, permsOf } from '../src/common/perm';

describe('C75 — 4역할·5인 신규 개발 DB 표본', () => {
  it('요청한 이름·역할을 유지하고 관리자와 두 매니저의 기본 권한은 같다', () => {
    expect(base.STAFF.map(({ name, role }) => [name, role])).toEqual([
      ['김민선', 'ceo'], ['김민수', 'admin'], ['김범준', 'manager'],
      ['강민지', 'manager'], ['김재훈', 'teacher'],
    ]);
    for (const person of base.STAFF.filter((s) => canAdminPage(s.role) && !canSeeProfit(s.role))) {
      expect(permsOf(person.role)).toEqual(permsOf('admin'));
    }
  });

  it('모든 사람 참조와 회의 참석자는 STAFF에 존재하며 중복 참석자가 없다', () => {
    const ids = new Set<number>(base.STAFF.map((s) => s.id));
    const personKeys = new Set(['teacherId', 'staffId', 'ownerId', 'byId', 'toId', 'fromId',
      'replyBy', 'requesterId', 'resolvedBy', 'confirmedBy', 'createdBy', 'enteredBy', 'coordId', 'doneBy']);
    const invalid: string[] = [];
    function visit(value: unknown, path: string): void {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (personKeys.has(key) && typeof child === 'number' && !ids.has(child)) invalid.push(`${path}.${key}=${child}`);
        if (key === 'attendees' && Array.isArray(child)) {
          if (new Set(child).size !== child.length || child.some((id) => !ids.has(id))) invalid.push(`${path}.attendees`);
        }
        visit(child, `${path}.${key}`);
      }
    }
    visit({ base, money, ops, outputs, people, schedule }, 'seed');
    expect(invalid).toEqual([]);
  });

  it('예외를 적용한 단일 강사 일정에 중복 시간이 없다', () => {
    const raw = schedule.expand();
    const occs = schedule.applyExceptions(raw, schedule.resolveExceptions(raw))
      .filter((o) => !o.canceled && base.STAFF.some((s) => s.id === o.teacherId && !canAdminPage(s.role)));
    const conflicts: string[] = [];
    for (let i = 0; i < occs.length; i++) {
      for (const b of occs.slice(i + 1)) {
        const a = occs[i];
        if (a.teacherId === b.teacherId && a.onDate === b.onDate && a.startMin < b.endMin && b.startMin < a.endMin) {
          conflicts.push(`${a.onDate}: ${a.serId}/${b.serId}`);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('상대 nth 시간 이동은 기준일 요일이 바뀌어도 원본 반복표 어느 요일과도 겹치지 않는다', () => {
    const conflicts: string[] = [];
    for (const exception of schedule.EXCEPTIONS.filter((row) => row.startMin !== undefined && !row.canceled)) {
      const source = schedule.SERS.find((row) => row.id === exception.serId)!;
      for (const dow of source.days) {
        for (const other of schedule.SERS.filter((row) => (
          row.id !== source.id && row.teacherId === source.teacherId && row.days.includes(dow)
        ))) {
          if (exception.startMin! < other.endMin && other.startMin < exception.endMin!) {
            conflicts.push(`ser${source.id}/ser${other.id}/dow${dow}`);
          }
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('승인된 시간 변경 요청은 실제 회차 예외와 같은 날짜와 값을 사용한다', () => {
    const exceptions = schedule.resolveExceptions(schedule.expand());
    for (const request of ops.CHREQS.filter((r) => r.state === 'approved' && r.reqType === 'time_move')) {
      const exception = exceptions.find((e) => e.serId === request.serId && e.onDate === request.onDate);
      expect(exception).toMatchObject(request.payload);
    }
  });

  it('같은 강사의 건의는 월 3개를 넘지 않는다', () => {
    const counts = new Map<string, number>();
    for (const row of ops.SUGGESTIONS) {
      const key = `${row.staffId}/${row.createdAt.slice(0, 7)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((count) => count <= 3)).toBe(true);
  });
});
