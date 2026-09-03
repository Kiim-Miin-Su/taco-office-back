/**
 * 결재 흐름 — 다섯 갈래를 **한 모양으로** 만든다 (D-R26 · §14 · §75).
 *
 * 승인 대기함(§14)과 결재 흐름 오버레이(§75)는 **같은 데이터를 다르게 묶어 보여 줄 뿐**이다.
 * 두 화면이 각자 정규화하면 배지 숫자와 목록이 어긋난다 — 그래서 여기 한 곳에서만 만든다.
 *
 * 순수 함수다. 행을 읽어 오는 일은 서비스가 하고, 여기서는 모양만 바꾼다 —
 * DB 없이 테스트할 수 있어야 규칙이 굳는다.
 *
 * ⚠ `GPAPACK` 은 아직 표가 없다 (N-13 대기). 다섯 갈래 중 **넷만** 정규화한다.
 *    빠졌다는 사실을 `ApFlow.missingKinds` 로 내보내 화면이 말할 수 있게 한다 —
 *    조용히 네 갈래만 보여 주면 「자료 요청은 결재가 없나 보다」가 된다.
 */

/** 결재가 도는 다섯 갈래 (D-R26) */
export const AP_KINDS = ['rpt', 'plan', 'req', 'chreq', 'gpapack'] as const;
export type ApKind = (typeof AP_KINDS)[number];

/**
 * 아직 표가 없어 정규화하지 못하는 것 — **지금은 없다.**
 *
 * 한동안 여기에 `gpapack` 이 들어 있었는데 틀린 것이었다. 표는 처음부터 있었고
 * 시드만 비어 있었다. N-13 으로 막혀 있는 것은 GPA **점수 저장**(§82)이지
 * 자료 요청 결재가 아니다. 화면에 「못 셉니다」라고 적어 두면 아무도 다시 안 본다.
 */
export const AP_KINDS_MISSING: ApKind[] = [];

export const AP_KIND_LABEL: Record<ApKind, string> = {
  rpt: '대표 보고',
  plan: '기획',
  req: '요청',
  chreq: '변경 요청',
  gpapack: '자료 요청',
};

/**
 * 낱말 → 사람이 읽는 이름 (D-R18 · 이름의 출처는 하나여야 한다).
 *
 * 서버가 제목을 만들 때도, 화면이 이력 표를 그릴 때도 이 표를 본다.
 * 여기 없는 값은 **그대로 보여 준다** — 「기타」로 뭉개면 새 종류가 생긴 것을 아무도 모른다.
 */
export const REQ_TYPE_LABEL: Record<string, string> = {
  // REQ — 사람이 올리는 요청
  wage_change: '시급 변경', unav_add: '불가 시간 추가', doc: '서류',
  // CHREQ — 수업을 바꿔 달라는 요청
  time: '시간 변경', time_move: '시간 이동', teacher: '강사 변경',
  room: '강의실 변경', off: '휴강', cancel: '취소',
};

/** 기존 import 경로는 유지하되 종류의 정본은 변경요청 도메인 파일에 둔다. */
export { CHREQ_TYPES, type ChreqType } from './change-request';

export const GPAPACK_TYPE_LABEL: Record<string, string> = {
  exam: '시험 대비', self: '자습',
};

export const RPT_TYPE_LABEL: Record<string, string> = {
  day: '일간', week: '주간', month: '월간',
};

/** 표에 없는 낱말은 감추지 않고 그대로 보여 준다 */
export const labelOf = (table: Record<string, string>, key: string): string => table[key] ?? key;

/**
 * 한 줄의 상태. 표마다 낱말이 다르므로 **여기서 세 가지로 좁힌다.**
 *   waiting  기다리는 것 — 내가 승인해야 하거나, 남이 승인해 주기를 기다리는 것
 *   back     되돌아온 것 — 반려. 목록 맨 위로 올라간다 (§75)
 *   done     끝난 것
 */
export type ApState = 'waiting' | 'back' | 'done';

/** §75 가 요구하는 한 줄 — `{k,id,t,s,by,at,st,why,go}` */
export interface ApRow {
  kind: ApKind;
  id: number;
  /** 사람이 읽는 제목 */
  title: string;
  /** 부제 — 종류나 날짜처럼 한 줄 더 */
  sub: string | null;
  /** 올린 사람 */
  byId: number | null;
  byName: string | null;
  at: string;
  state: ApState;
  /** 반려 사유 — `state==='back'` 이면 반드시 있다 (D-R13) */
  why: string | null;
  /** 누르면 갈 곳. 오버레이에서 승인하지 않는다 (D-R27) */
  go: string;
}

export interface ApFlow {
  /** 되돌아온 것 → 기다리는 것 → 내가 올린 것 순 (§75) */
  back: ApRow[];
  waiting: ApRow[];
  mine: ApRow[];
  /** 배지 숫자 — `apCount()` */
  count: number;
  /** 아직 표가 없어 못 세는 갈래 */
  missingKinds: ApKind[];
}

export const AP_STATE_WORDS: Record<ApState, readonly string[]> = {
  // 되돌아온 것 — PLAN.stage 의 rework 가 여기 붙는다
  back: ['rejected', 'rej', 'rework', 'denied', 'no', 'back'],
  // 끝난 것
  done: ['approved', 'ok', 'done', 'closed', 'applied'],
  /**
   * 기다리는 것 — 기본값이기도 하다.
   *
   * ⚠ `sent` 가 여기 있는 것이 중요하다. TBO-29 에서 「나갔으니 끝난 것」이라 보고
   * `done` 에 넣었는데 **틀렸다.** RPT 에서 `sent` 는 「대표께 올렸고 검토를 기다린다」는 뜻이다
   * (`erd.dbml` RPT: `draft | sent | ok | rej` · `reviewed_at` 이 그 뒤에 찍힌다).
   * 그래서 제출된 대표 보고 4건이 승인 대기함에서 통째로 빠져 있었다 — D-R34 가 말하는
   * 「전건이 뜬다」의 정반대다. 안내(GUIDE)의 `sent` 는 발송 완료지만, 그 표는 결재를 돌지 않는다.
   */
  waiting: ['pending', 'review', 'submitted', 'sent', 'wait', 'open', 'draft'],
};

/**
 * 표마다 다른 상태 낱말을 셋으로 좁힌다.
 *
 * 모르는 값은 **기다리는 것**으로 둔다 — 사라지는 것보다 낫다.
 * 다만 그 관대함이 낱말이 어긋난 것을 덮어 버리므로,
 * `test/approval.spec.ts` 가 **DB 에 실제로 있는 낱말이 전부 위 표에 있는지** 검사한다.
 */
export function toApState(raw: string | null | undefined): ApState {
  const v = String(raw ?? '').toLowerCase();
  if (AP_STATE_WORDS.back.includes(v)) return 'back';
  if (AP_STATE_WORDS.done.includes(v)) return 'done';
  return 'waiting';
}

/** 표에 없는 낱말인가 — 조용한 오분류를 잡으려고 테스트가 쓴다 */
export const isKnownApWord = (raw: string | null | undefined): boolean =>
  Object.values(AP_STATE_WORDS).some((ws) => ws.includes(String(raw ?? '').toLowerCase()));

/**
 * 다섯(지금은 넷) 갈래를 한 목록으로 묶는다.
 *
 * @param viewerId  「내가 올린 것」을 가르는 기준
 * @param canApprove 승인 권한이 있는가 — 없으면 `waiting` 에 남의 건이 들어가지 않는다 (D-R39)
 */
export function apFlow(
  rows: ApRow[],
  viewerId: number,
  canApprove: boolean,
): ApFlow {
  const back: ApRow[] = [];
  const waiting: ApRow[] = [];
  const mine: ApRow[] = [];

  for (const r of rows) {
    const isMine = r.byId !== null && r.byId === viewerId;
    // 남의 결재는 승인 권한이 있을 때만 **목록에서 아예 뺀다.**
    // 감추기만 하면 「있다」는 사실이 배지 숫자로 새어 나간다 (D-R39).
    if (!isMine && !canApprove) continue;

    // 되돌아온 것이 맨 위 — 내 것이든 남의 것이든 (§75)
    if (r.state === 'back') { back.push(r); continue; }
    if (r.state === 'done') { if (isMine) mine.push(r); continue; }
    // 기다리는 것 — 내가 올린 것은 「내가 올린 것」으로, 남의 것은 승인 대기로
    if (isMine) mine.push(r);
    else waiting.push(r);
  }

  const byAtDesc = (a: ApRow, b: ApRow) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  back.sort(byAtDesc); waiting.sort(byAtDesc); mine.sort(byAtDesc);

  return {
    back, waiting, mine,
    // 배지는 **손이 가야 하는 것**만 센다 — 끝난 것은 안 센다
    count: back.length + waiting.length,
    missingKinds: [...AP_KINDS_MISSING],
  };
}

/** 「김민선 → 대표」처럼 누가 누구에게를 한 문장으로 (§75 표시 규약) */
export function apSentence(r: ApRow, toName: string | null): string {
  const from = r.byName ?? '알 수 없음';
  return toName ? `${from} → ${toName}` : from;
}
