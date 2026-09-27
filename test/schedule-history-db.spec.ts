/** @file-guide
 * 목적: schedule-history-db.spec.ts (test) — §20 「최근 변경 이력」(W11 A' 후속 P) — 스케줄 감사 줄을 읽는 서버 문장과 볼 수 있는 범위
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원문 §20 컷의 이력 줄 — 「누가 —」 · 「앞 → 뒤」 · 「SAT Reading 8/28 → 20:00 이동 (이 주만)」.
 *   ① 실제 일정 쓰기(만들기 · 이번 회차 옮기기 · 강사 바꾸기 · 휴강)가 남긴 감사 줄을 최근 것부터 원문 모양의 문장으로 읽는다
 *   ② 볼 수 있는 범위는 §20 목록과 같다 — 전체 권한이면 모두 · 아니면 내가 한 것만
 *   ③ 순수 문장 함수의 경계 — 단발 · 반복 · 삭제 · 되돌리기 · 명단 · 모르는 이름(지어내지 않는다)
 *
 * ⚠ 일정 쓰기는 제 트랜잭션을 연다 — 스크래치 DB(`*_test`)에서만 돌고 만든 행은 스스로 지운다. 이 스위트 전용 id 986x.
 */
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/data-source';
import { Lead } from '../src/entities';
import { DrawerService } from '../src/modules/drawer/drawer.service';
import { ScheduleWriteService } from '../src/modules/schedule/schedule.write.service';
import { scheduleHistoryLine } from '../src/lib/schedule-history';
import { assertScratch, TEST_URL } from './db';

const names = {
  teacher: (id: number) => ({ 1: '김재훈', 2: 'KJ' } as Record<number, string>)[id] ?? null,
  room: (id: number) => ({ 5: '6호' } as Record<number, string>)[id] ?? null,
  student: (id: number) => ({ 7: '민리인', 8: '김하윤', 9: '이서우' } as Record<number, string>)[id] ?? null,
};

describe('§20 이력 한 줄 — 순수 문장 함수 (lib/schedule-history)', () => {
  const line = (action: string, before: unknown, after: unknown, name = 'SAT Reading') =>
    scheduleHistoryLine({ action, before, after, name }, names);

  it('원문 컷의 네 모양 — 생성(단발) · 이동(이 주만) · 강사(이 주만) · 휴강(이 주만)', () => {
    expect(line('create', undefined, { rrule: 'ONCE', title: '민리인' }, '진단고사 · 민리인'))
      .toEqual({ summary: '진단고사 · 민리인 생성 (단발)', from: null, to: null });
    expect(line('patch', { exc: { '2026-08-28': null } }, { exc: { '2026-08-28': { startMin: 1200, endMin: 1260 } } }))
      .toEqual({ summary: 'SAT Reading 8/28 → 20:00 이동 (이 주만)', from: null, to: '20:00' });
    expect(line('patch', { exc: { '2026-08-28': null } }, { exc: { '2026-08-28': { teacherSet: true, teacherId: 2 } } }, 'MAP Reading'))
      .toEqual({ summary: 'MAP Reading 8/28 강사 → KJ (이 주만)', from: null, to: 'KJ' });
    expect(line('delete', { exc: { '2026-08-28': null } }, { exc: { '2026-08-28': { canceled: true } } }, 'Interview'))
      .toEqual({ summary: 'Interview 8/28 휴강 (이 주만)', from: '수업', to: '휴강' });
  });

  it('규칙 칸은 「반복 규칙」 · 반복 생성 · 삭제 · 되돌리기 · 명단 · 모르는 이름은 지어내지 않는다', () => {
    expect(line('patch', { teacherId: 1, startMin: 960 }, { teacherId: 3, startMin: 1020 }))
      .toEqual({ summary: 'SAT Reading 시각 → 17:00 · 강사 → 미지정 (반복 규칙)', from: '16:00', to: '17:00' });
    expect(line('create', undefined, { rrule: 'WEEKLY:TH' }).summary).toBe('SAT Reading 생성 (반복)');
    expect(line('delete', { rrule: 'ONCE' }, undefined).summary).toBe('SAT Reading 삭제');
    expect(line('undo', { exc: { '2026-08-28': { canceled: true } } }, { exc: { '2026-08-28': null } }).summary)
      .toBe('SAT Reading 8/28 휴강 취소 (이 주만) · 되돌리기');
    expect(line('roster', { roster: [{ studentId: 8 }] }, { roster: [{ studentId: 8 }, { studentId: 7 }, { studentId: 99 }] }).summary)
      .toBe('SAT Reading 명단 + 민리인, 학생');
    expect(line('roster', { roster: [{ studentId: 7 }, { studentId: 8 }, { studentId: 9 }] }, { roster: [] }).summary)
      .toBe('SAT Reading 명단 − 민리인, 김하윤 외 1명');
    // 둘 넘게 바뀌면 둘까지 적고 「외 N」 — 원문의 줄은 한 줄이다
    expect(line('patch', { teacherId: 1, roomId: 5, mode: 'offline' }, { teacherId: 2, roomId: null, mode: 'online' }).summary)
      .toBe('SAT Reading 강사 → KJ · 강의실 → 미지정 외 1 (반복 규칙)');
    // 사유만 적힌 예외(줌 배정으로 생긴 줄 — 줌 계정은 원장에 없다)
    expect(line('patch', { exc: { '2026-08-28': null } }, { exc: { '2026-08-28': { reason: '줌 계정 배정' } } }).summary)
      .toBe('SAT Reading 8/28 줌 계정 배정 (이 주만)');
  });
});

const d = TEST_URL ? describe : describe.skip;
jest.setTimeout(90_000);
const url = TEST_URL ? assertScratch(TEST_URL) : '';

const BOSS = 9861;
const T1 = 9862;
const T2 = 9863;
const STAFF = [BOSS, T1, T2];

d('§20 이력 — 실제 일정 쓰기의 감사 줄을 읽는다 (drawer.scheduleHistory)', () => {
  let ds: DataSource;
  let drawer: DrawerService;
  let write: ScheduleWriteService;
  const made = { kind: [] as string[], sub: [] as string[], ser: [] as number[] };
  const q = <T0 = Record<string, unknown>>(sql: string, p: unknown[] = []) => ds.query(sql, p) as Promise<T0[]>;

  const cleanup = async () => {
    await q(`DELETE FROM log WHERE actor_id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM noti WHERE to_id = ANY($1) OR from_id = ANY($1)`, [STAFF]);
    const sers = (await q<{ id: string }>(`SELECT id FROM ser WHERE teacher_id = ANY($1) OR id = ANY($2)`, [STAFF, made.ser]))
      .map((r) => Number(r.id));
    await q(`DELETE FROM ser_occ WHERE ser_id = ANY($1)`, [sers]);
    await q(`DELETE FROM exc_stu_out WHERE exc_id IN (SELECT id FROM exc WHERE ser_id = ANY($1))`, [sers]);
    await q(`DELETE FROM exc WHERE ser_id = ANY($1)`, [sers]);
    await q(`DELETE FROM ser_stu WHERE ser_id = ANY($1)`, [sers]);
    await q(`DELETE FROM ser WHERE id = ANY($1)`, [sers]);
  };

  beforeAll(async () => {
    if (dataSourceOptions.type !== 'postgres') throw new Error('PostgreSQL required');
    ds = new DataSource({ ...dataSourceOptions, url, ssl: false, logging: false });
    await ds.initialize();
    write = new ScheduleWriteService(ds);
    drawer = new DrawerService(ds.getRepository(Lead));
    await cleanup();
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
    await q(
      `INSERT INTO staff (id,name,email,role) VALUES
         ($1,'이력 관리자','hist9861@t.kr','admin'),
         ($2,'첫째강사','hist9862@t.kr','teacher'),
         ($3,'둘째강사','hist9863@t.kr','teacher')`, STAFF,
    );
    if ((await q(`SELECT key FROM kind WHERE key = 'hist_test'`)).length === 0) {
      await q(`INSERT INTO kind (key,name,color,cap,grp) VALUES ('hist_test','이력검증','#333333',4,'lesson')`);
      made.kind.push('hist_test');
    }
    if ((await q(`SELECT key FROM sub WHERE key = 'hist-sub'`)).length === 0) {
      await q(`INSERT INTO sub (key,name,color) VALUES ('hist-sub','히스토리 과목','#444444')`);
      made.sub.push('hist-sub');
    }
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM staff WHERE id = ANY($1)`, [STAFF]);
    await q(`DELETE FROM sub WHERE key = ANY($1)`, [made.sub]);
    await q(`DELETE FROM kind WHERE key = ANY($1)`, [made.kind]);
    if (ds?.isInitialized) await ds.destroy();
  });

  it('만들기 · 이번 회차 옮기기 · 강사 바꾸기 · 휴강이 최근 것부터 원문 모양의 문장으로 · 전체 권한이 아니면 내가 한 것만', async () => {
    const base = { kindKey: 'hist_test', subKey: 'hist-sub', mode: 'offline', startMin: 960, endMin: 1020, teacherId: T1 };
    const once = await write.create({ ...base, rrule: 'ONCE', fromDate: '2026-12-01', toDate: '2026-12-01' } as never, BOSS);
    made.ser.push(...once.serIds);
    const weekly = await write.create({ ...base, rrule: 'WEEKLY:TH', fromDate: '2026-12-03', toDate: '2026-12-24' } as never, BOSS);
    made.ser.push(...weekly.serIds);
    const serId = weekly.serIds[0];
    await write.patch(serId, { scope: 'this', onDate: '2026-12-10', startMin: 1200, endMin: 1260 } as never, undefined, BOSS);
    await write.patch(serId, { scope: 'this', onDate: '2026-12-17', teacherId: T2 } as never, undefined, BOSS);
    await write.remove(serId, { scope: 'this', onDate: '2026-12-24' } as never, undefined, BOSS);

    const all = await drawer.scheduleHistory(BOSS, true);
    expect(all.rows.slice(0, 5).map((r) => [r.actorName, r.summary, r.from, r.to])).toEqual([
      ['이력 관리자', '히스토리 과목 12/24 휴강 (이 주만)', '수업', '휴강'],
      ['이력 관리자', '히스토리 과목 12/17 강사 → 둘째강사 (이 주만)', null, '둘째강사'],
      ['이력 관리자', '히스토리 과목 12/10 → 20:00 이동 (이 주만)', null, '20:00'],
      ['이력 관리자', '히스토리 과목 생성 (반복)', null, null],
      ['이력 관리자', '히스토리 과목 생성 (단발)', null, null],
    ]);
    expect(all.rows[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(all.rows.length).toBeLessThanOrEqual(20);
    // 전체 권한이 아니면 **내가 한 것만** — 강사는 일정을 직접 쓰지 않으므로 비어 있다(§20 목록의 by_id = 나 와 같은 모양)
    expect((await drawer.scheduleHistory(T1, false)).rows).toEqual([]);
  });
});
