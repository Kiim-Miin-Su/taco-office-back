/** @file-guide
 * 목적: approval.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 결재 정규화 — `lib/approval.ts` (D-R26 · D-R34 · D-R39).
 *
 * DB 없이 돈다. 규칙이 순수 함수 안에 있으니 표를 안 세우고도 굳힐 수 있다.
 * §14 승인 대기함과 §75 결재 흐름이 **같은 함수**를 보는 것이 이 파일이 지키는 것이다.
 */
import {
  apFlow, approvalFlowProjection, apSentence, toApState, AP_KINDS, AP_KINDS_MISSING, AP_STATE_WORDS,
  isKnownApWord, type ApRow,
} from '../src/lib/approval';

const row = (p: Partial<ApRow> & Pick<ApRow, 'id'>): ApRow => ({
  kind: 'rpt', title: '보고', sub: null, byId: 9, byName: '김민선',
  at: '2026-08-30T09:00:00+09:00', state: 'waiting', why: null, go: '/exec', ...p,
});

const ME = 1;
const OTHER = 9;

describe('toApState — 표마다 다른 낱말을 셋으로', () => {
  it('반려 계열은 back', () => {
    ['rej', 'rejected', 'no', 'rework', 'back', 'REJ', 'denied'].forEach((v) =>
      expect(toApState(v)).toBe('back'));
  });
  it('끝난 계열은 done', () => {
    ['ok', 'approved', 'done', 'closed', 'applied'].forEach((v) =>
      expect(toApState(v)).toBe('done'));
  });
  it('★ RPT 의 sent 는 「올렸고 기다린다」다 — 끝난 것이 아니다', () => {
    // 한 번 done 으로 넣었다가 제출된 대표 보고 4건이 승인 대기함에서 통째로 사라졌다
    expect(toApState('sent')).toBe('waiting');
  });
  it('기다리는 계열도 표에 적혀 있다 — 기본값에 기대지 않는다', () => {
    ['pending', 'review', 'submitted', 'sent', 'draft'].forEach((v) => {
      expect(toApState(v)).toBe('waiting');
      expect(isKnownApWord(v)).toBe(true);
    });
  });
  it('한 낱말이 두 묶음에 들어가 있지 않다', () => {
    const all = Object.values(AP_STATE_WORDS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  it('모르는 값은 사라지지 않고 waiting 으로 남는다', () => {
    expect(toApState('무언가')).toBe('waiting');
    expect(toApState(null)).toBe('waiting');
    expect(toApState(undefined)).toBe('waiting');
  });
});

describe('apFlow — 세 묶음', () => {
  it('D-R34 · 승인자에게는 남의 대기건이 전건 뜬다', () => {
    const f = apFlow([
      row({ id: 1, byId: OTHER }),
      row({ id: 2, byId: OTHER }),
      row({ id: 3, byId: OTHER }),
    ], ME, true);
    expect(f.waiting).toHaveLength(3);
    expect(f.count).toBe(3);
  });

  it('내가 올린 것은 대기함이 아니라 「내가 올린 것」으로 간다', () => {
    const f = apFlow([row({ id: 1, byId: ME })], ME, true);
    expect(f.waiting).toHaveLength(0);
    expect(f.mine).toHaveLength(1);
  });

  it('반려는 맨 위 묶음으로 — 내 것이든 남의 것이든', () => {
    const f = apFlow([
      row({ id: 1, byId: ME, state: 'back', why: '근거 없음' }),
      row({ id: 2, byId: OTHER, state: 'back', why: '기간 오류' }),
    ], ME, true);
    expect(f.back.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(f.mine).toHaveLength(0);
  });

  it('D-R39 · 승인 권한이 없으면 남의 건은 목록에서 아예 빠진다', () => {
    const f = apFlow([
      row({ id: 1, byId: OTHER }),
      row({ id: 2, byId: OTHER, state: 'back', why: 'x' }),
      row({ id: 3, byId: ME }),
    ], ME, false);
    expect(f.waiting).toHaveLength(0);
    expect(f.back).toHaveLength(0);   // 「있다」는 사실도 안 흘린다
    expect(f.mine.map((r) => r.id)).toEqual([3]);
  });

  it('배지는 손이 가야 하는 것만 센다 — 끝난 것은 안 센다', () => {
    const f = apFlow([
      row({ id: 1, byId: OTHER, state: 'waiting' }),
      row({ id: 2, byId: OTHER, state: 'back', why: 'x' }),
      row({ id: 3, byId: OTHER, state: 'done' }),
      row({ id: 4, byId: ME, state: 'waiting' }),
    ], ME, true);
    expect(f.count).toBe(f.back.length + f.waiting.length);
    expect(f.count).toBe(2);
  });

  it('끝난 남의 건은 아무 묶음에도 담기지 않는다', () => {
    const f = apFlow([row({ id: 1, byId: OTHER, state: 'done' })], ME, true);
    expect(f.back.length + f.waiting.length + f.mine.length).toBe(0);
  });

  it('byId 가 null 이면 내 것으로 오해하지 않는다', () => {
    const f = apFlow([row({ id: 1, byId: null })], ME, true);
    expect(f.mine).toHaveLength(0);
    expect(f.waiting).toHaveLength(1);
  });

  it('최신이 위로', () => {
    const f = apFlow([
      row({ id: 1, byId: OTHER, at: '2026-08-01T00:00:00+09:00' }),
      row({ id: 2, byId: OTHER, at: '2026-08-30T00:00:00+09:00' }),
    ], ME, true);
    expect(f.waiting.map((r) => r.id)).toEqual([2, 1]);
  });

  it('공통 결재 다섯 갈래와 강사 리포트가 정규화된다 — 빠진 갈래가 없다 (D-R26·D-R34)', () => {
    const f = apFlow([], ME, true);
    // 한동안 gpapack 이 「표가 없다」로 빠져 있었는데 표는 처음부터 있었다
    expect(f.missingKinds).toEqual([]);
    expect(AP_KINDS).toEqual(['rep', 'rpt', 'plan', 'req', 'chreq', 'gpapack', 'suggestion', 'missing']);
    expect(AP_KINDS_MISSING.every((k) => (AP_KINDS as readonly string[]).includes(k))).toBe(true);
  });

  it('D-R13 · 반려면 사유가 함께 온다', () => {
    const f = apFlow([row({ id: 1, byId: OTHER, state: 'back', why: '근거 없음' })], ME, true);
    expect(f.back[0].why).toBe('근거 없음');
  });

  it('§14 inbox는 요청·건의·GPA·누락만 세고 §75 보고는 섞지 않는다', () => {
    const f = apFlow([
      row({ id: 1, kind: 'rpt' }),
      row({ id: 2, kind: 'req', reqType: 'wage_change' }),
      row({ id: 3, kind: 'chreq', reqType: 'time_move' }),
      row({ id: 4, kind: 'suggestion' }),
      row({ id: 5, kind: 'missing' }),
      row({ id: 6, kind: 'gpapack', state: 'done' }),
    ], ME, true);
    expect(f.inbox.map((r) => r.id)).toEqual([2, 3, 4, 5]);
    expect(f.inboxCount).toBe(f.inbox.length);
    expect(f.categories.find((c) => c.key === 'wage_change')?.count).toBe(1);
    expect(f.categories.find((c) => c.key === 'schedule_change')?.count).toBe(1);
    expect(f.categories.find((c) => c.key === 'book_change')?.count).toBe(0);
  });

  it('§14 inbox는 승인 권한이 없으면 행과 건수를 모두 숨긴다', () => {
    const f = apFlow([row({ id: 1, kind: 'req', reqType: 'tz_change' })], ME, false);
    expect(f.inbox).toEqual([]);
    expect(f.inboxCount).toBe(0);
  });
});

describe('apSentence — 누가 누구에게', () => {
  it('받는 사람이 있으면 화살표로', () => {
    expect(apSentence(row({ id: 1 }), '대표')).toBe('김민선 → 대표');
  });
  it('없으면 올린 사람만', () => {
    expect(apSentence(row({ id: 1 }), null)).toBe('김민선');
  });
  it('이름이 비어도 빈칸을 보여 주지 않는다', () => {
    expect(apSentence(row({ id: 1, byName: null }), '대표')).toBe('알 수 없음 → 대표');
  });
});

describe('§75 approvalFlowProjection — exact 5종·수신자·역할 투영', () => {
  const rows: ApRow[] = [
    row({ id: 1, kind: 'rpt', byId: null, byName: null, go: '/exec?view=day&date=2026-09-14&rpt=1' }),
    row({ id: 2, kind: 'plan', byId: OTHER, state: 'back', why: '근거 부족' }),
    row({ id: 3, kind: 'req', byId: OTHER }),
    row({ id: 4, kind: 'chreq', byId: OTHER }),
    row({ id: 5, kind: 'gpapack', byId: ME }),
    row({ id: 6, kind: 'rep' }),
    row({ id: 7, kind: 'suggestion' }),
    row({ id: 8, kind: 'missing' }),
    row({ id: 9, kind: 'plan', byId: ME, state: 'back', why: '내 기획 보완' }),
  ];

  it('대표는 대표·실장 수신 전체를 보고 타일은 waiting만 세다', () => {
    const flow = approvalFlowProjection(rows, ME, 'all');
    expect(flow.tiles.map((tile) => [tile.kind, tile.kindLabel, tile.toLabel, tile.count])).toEqual([
      ['rpt', '대표 보고', '대표에게', 1],
      ['plan', '기획 결재', '대표에게', 0],
      ['req', '강사 요청', '실장에게', 1],
      ['chreq', '변경 요청', '실장에게', 1],
      ['gpapack', '자료 요청', '실장에게', 0],
    ]);
    expect(flow.total).toBe(flow.waiting.length);
    expect(flow.back).toEqual([expect.objectContaining({ id: 9, state: 'back', why: '내 기획 보완' })]);
    expect(flow.mine).toEqual([expect.objectContaining({ id: 5, state: 'mine' })]);
    expect(flow.waiting.find((item) => item.id === 1)).toMatchObject({
      byName: '알 수 없음', to: 'ceo', toName: '대표', toLabel: '대표에게',
    });
    expect([...flow.back, ...flow.waiting, ...flow.mine].map((item) => item.kind))
      .not.toEqual(expect.arrayContaining(['rep', 'suggestion', 'missing']));
  });

  it('관리자·매니저는 실장 수신 대기만 받고 대표 수신 건은 건수도 안 샌다', () => {
    const flow = approvalFlowProjection(rows, ME, 'head');
    expect(flow.waiting.map((item) => item.kind)).toEqual(['req', 'chreq']);
    expect(flow.total).toBe(2);
    expect(flow.tiles.find((tile) => tile.kind === 'rpt')?.count).toBe(0);
    expect(flow.back).toEqual([expect.objectContaining({ id: 9 })]);
  });

  it('강사 projection은 트리거·타일·행·건수가 모두 0이다', () => {
    expect(approvalFlowProjection(rows, ME, 'none')).toEqual({
      canView: false, tiles: [], back: [], waiting: [], mine: [], total: 0, backCount: 0,
    });
  });
});
