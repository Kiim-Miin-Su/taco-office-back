/** @file-guide
 * 목적: consulting-service.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { InternalServerErrorException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Lead } from '../src/entities';
import { ConsultingService } from '../src/modules/consulting/consulting.service';

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: '1', cons_type: 'future_type', stage: 'contract', contract_step: null,
  sessions: null, amount: 100000, share: 'all', owner_id: '9', is_picked: false,
  student_names: ['계약 테스트'], owner_name: '담당 테스트', created_at: '2026-09-07', end_on: null,
  ...over,
});
const log = (over: Row = {}): Row => ({ id: '11', cons_id: '1', seq: 1, on_date: null,
  who: null, what: '비공개 회차 내용', why: null, how: null, ser_id: null, ...over });

function service(rows: Row[], logs: Row[] = [log()]) {
  const query = jest.fn().mockResolvedValueOnce(rows).mockImplementation((_sql: string, [ids]: [number[]]) =>
    Promise.resolve(logs.filter((r) => ids.includes(Number(r.cons_id)))));
  return { svc: new ConsultingService({ query } as unknown as Repository<Lead>), query };
}

describe('§26 조회 계약과 공개 범위', () => {
  it('새 종류 코드를 유지하고 DB의 날짜 미정은 문자열 null이 아닌 null로 반환한다', async () => {
    const { svc } = service([row()]);
    const { items } = await svc.all(2, false, false);
    expect(items[0]).toMatchObject({ consType: 'future_type', contractStep: null, sessions: null, amount: null });
    expect(items[0].sessionsLog[0].onDate).toBeNull();
  });

  it('외부인은 공개 건 내용만 조회하고 수납만 공개 건 내용·지정/비공개 존재를 누출하지 않는다', async () => {
    const { svc, query } = service(['all', 'money_only', 'picked', 'private'].map((share, i) => row({ id: i + 1, share })));
    const result = await svc.all(2, true, false);
    expect(result.items.map(({ id, canOpen, amount }) => ({ id, canOpen, amount }))).toEqual([
      { id: 1, canOpen: true, amount: 100000 }, { id: 2, canOpen: false, amount: 100000 },
    ]);
    expect(result.items[1].sessionsLog).toEqual([]);
    expect(query.mock.calls[1][0]).toContain('WHERE cons_id = ANY($1::bigint[])');
    expect(query.mock.calls[1][1]).toEqual([[1]]);
  });

  it.each([
    { viewer: 9, canHide: false, isPicked: false, expected: [1, 2, 3, 4] },
    { viewer: 2, canHide: true, isPicked: false, expected: [1, 2, 3, 4] },
    { viewer: 2, canHide: false, isPicked: true, expected: [1, 3] },
  ])('담당/열람권/지정 권한은 기존 csCan* 결과를 유지한다: %p', async ({ viewer, canHide, isPicked, expected }) => {
    const { svc, query } = service(['all', 'money_only', 'picked', 'private'].map((share, i) => row({ id: i + 1, share, is_picked: isPicked })));
    const result = await svc.all(viewer, false, canHide);
    expect(result.items.filter((r) => r.canOpen).map((r) => r.id)).toEqual(expected);
    expect(result.items.every((r) => r.amount === null)).toBe(true);
    expect(query.mock.calls[1][1]).toEqual([expected]);
  });

  it('숨겨진 오염 건은 오류로 존재를 누출하지 않고 열람 가능한 회차가 없으면 쿼리도 생략한다', async () => {
    const { svc, query } = service([row({ share: 'private', stage: 'corrupt' })]);
    expect((await svc.all(2, false, false)).items).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([{ stage: 'corrupt' }, { stage: 'running', contract_step: null }, { sessions: 0 }])('보이는 오염 건 %p는 공통 오류로 차단한다', async (over) => {
    const { svc } = service([row(over)]);
    await expect(svc.all(2, false, false)).rejects.toThrow(new InternalServerErrorException('컨설팅 데이터 무결성 오류'));
  });

  it.each([[log({ seq: 0 })], [log(), log({ id: '12' })]])('회차 순번 오염/중복을 차단한다', async (...logs) => {
    const { svc } = service([row()], logs);
    await expect(svc.all(2, false, false)).rejects.toThrow('컨설팅 데이터 무결성 오류');
  });
});
