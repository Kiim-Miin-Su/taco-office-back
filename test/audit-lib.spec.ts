/** @file-guide
 * 목적: audit-lib.spec.ts — 감사 목록 한 벌(`lib/audit`)의 모양과 `audit()` 가 적는 줄 (N-73 · W11)
 * 책임/재사용: DB 없이 목록 규칙(이름 길이 · 유일)과 INSERT 인자만 본다. 실제 쓰기의 감사 줄은 각 기능의 DB 시험이 센다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { AUDIT_WRITES, audit } from '../src/lib/audit';

describe('감사 목록 (N-73 · lib/audit)', () => {
  it('entity · action 은 log 칸(varchar 20)에 들어가고 key 는 겹치지 않는다', () => {
    const keys = AUDIT_WRITES.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const w of AUDIT_WRITES) {
      expect(w.entity.length).toBeLessThanOrEqual(20);
      expect(w.action.length).toBeLessThanOrEqual(20);
      expect(w.entity).toBe(w.entity.toUpperCase());
      expect(w.why.length).toBeGreaterThan(0);
    }
  });

  it('스케줄은 규칙(SER) 한 줄 — 투영 표 이름은 목록에 없다', () => {
    const entities = new Set<string>(AUDIT_WRITES.map((w) => w.entity));
    expect(entities.has('SER')).toBe(true);
    for (const projection of ['SER_OCC', 'ZASSIGN']) expect(entities.has(projection)).toBe(false);
  });

  it('audit() 는 표의 이름으로 한 줄을 적는다 · 없는 key 는 던진다 · 긴 action 은 던진다', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const q = { query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return []; } };
    await audit(q, 'expense.review', { actorId: '3', entityId: 11, before: { state: 'pending' }, after: { state: 'approved' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO log');
    expect(calls[0].params).toEqual([3, 'EXPENSE', 11, 'review', '{"state":"pending"}', '{"state":"approved"}']);
    await audit(q, 'unav.delete', { actorId: 7, entityId: 5, before: { on: '2026-10-01' } });
    expect(calls[1].params).toEqual([7, 'UNAV', 5, 'delete', '{"on":"2026-10-01"}', null]);
    await audit(q, 'request.review', { actorId: 1, entityId: 2, action: 'reject' });
    expect(calls[2].params?.[3]).toBe('reject');
    await expect(audit(q, 'nope' as never, { actorId: 1, entityId: 1 })).rejects.toThrow('감사 목록에 없는 쓰기');
    await expect(audit(q, 'request.review', { actorId: 1, entityId: 1, action: 'x'.repeat(21) })).rejects.toThrow('20자');
  });
});
