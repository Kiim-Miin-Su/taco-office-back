/** @file-guide
 * 목적: exec-areas.ts — EXEC_AREA_KEYS, ExecAreaKey, ExecAreaDef, EXEC_AREAS, areaCountSql 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 대표 보고 6영역 — **정의가 사는 단 하나의 자리** (§69 · DEV-SPEC §5.3).
 *
 * 「살펴볼 것 23」은 6영역 배지의 합이다(§69 원본: 2+0+1+1+2+17 = 23).
 * 머리 숫자와 영역 배지를 각자 세면 두 숫자가 어긋나고 어느 쪽이 맞는지 아무도 모른다
 * (AGENT §9 — 「같은 이름의 숫자를 두 곳에서 따로 셈」). 그래서 판정은 여기 한 곳에만 있다.
 *
 * 순서는 **대표 관심순으로 고정**이다 — 회계 → 마케팅 → 운영 → 컨설팅 → 컴플레인 → 수업 (D-R25).
 * 스케줄 변동은 대표 보고에서 제외한다.
 *
 * 수업 영역만 SQL 이 없다. 「교재·안내·줌·리포트가 덜 된 수업」 판정은 현황판(`clChk()`)이 이미
 * 갖고 있고, 서비스가 `BoardService` 를 불러 그 값을 그대로 쓴다 — 판정을 복사하지 않는다.
 */

import { CPL_OPEN_STAGES } from './complaint-words';
import { INV_OPEN } from './rules';
import { sqlWordList } from './sql';
import { planCanSql } from './plan-words';

/* ── 판정 조각 — 배지(건수)와 카드 타일이 **같은 조각**을 쓴다 (69-8 · N-19) ─────────────
 *
 * 카드 안 타일 「기한 지남 2건」과 머리 배지 「2」가 따로 적힌 WHERE 로 세면 언젠가 갈린다.
 * 그래서 「무엇을 세는가」는 여기 한 벌이고, 배지 SQL(`EXEC_AREAS[].sql`)과 서비스의 타일 SQL 이
 * 같은 함수를 부른다. 인자 `a` 는 표 별칭(빈 문자열이면 별칭 없이), `d` 는 기준일 파라미터다.
 */
const col = (a: string, c: string): string => (a ? `${a}.${c}` : c);

/** 아직 다 안 들어온 청구서 — 「못 받은 돈」의 집합. 완납·취소·초안은 빠진다 */
export const invOpenWhere = (a = ''): string => `${col(a, 'state')} IN (${sqlWordList(INV_OPEN)})`;

/**
 * 청구서의 **지금 기한** — 분납 일정(`inv_installment` · N-79 채택 W11)이 있으면 「누적 입금이 못 채운 가장 이른
 * 회차의 예정일」, 없으면 `due_on` 그대로. 다 채웠으면 NULL(볼 기한이 없다). 옛 청구서는 일정이 없어 전과 같다.
 * 연체 판정 · 회계 머리 「기한 지남」 · 청구서 줄 · §53 카드가 이 한 조각을 쓴다 — 두 곳이 따로 세면 배지와 카드가 갈린다.
 * `a` 는 inv 별칭 — 비우면 표 이름 `inv` 로 부른다(바깥이 `FROM inv` 일 때).
 */
export const invDueSql = (a = ''): string => {
  const t = a || 'inv';
  return `(CASE WHEN EXISTS (SELECT 1 FROM inv_installment ix WHERE ix.inv_id = ${t}.id)
      THEN (SELECT c.due_on FROM (SELECT ix.seq, ix.due_on, sum(ix.amount) OVER (ORDER BY ix.seq) AS cum
                                    FROM inv_installment ix WHERE ix.inv_id = ${t}.id) c
             WHERE c.cum > ${t}.paid_amount ORDER BY c.seq LIMIT 1)
      ELSE ${t}.due_on END)`;
};

/** 그중 기준일에 **지금 기한**(`invDueSql`)이 지난 것 — 회계 배지. 기한이 없으면(NULL) 세지 않는다 */
export const invOverdueWhere = (a = '', d = '$1'): string =>
  `${invOpenWhere(a)} AND ${invDueSql(a)} < ${d}::date`;

/** 대표 검토(review)를 기다리는 기획 — 초안은 아직 아무도 기다리지 않는다 */
export const planWaitingWhere = (a = ''): string => `${col(a, 'stage')} = 'review'`;

/**
 * 보는 사람에게 **보이는** 기획 (W11 · N-72) — 지정 공개는 담당 · 지정된 사람 · 결재권자에게만 보인다.
 * 판정은 `lib/plan-words` 의 `planCanSql` 한 곳이다 — §61 보드 · §62 기한 · §65 보고서와 같은 식이라 배지 · 타일 · 펼칠 줄의
 * 기획 수가 운영 화면과 갈리지 않는다. 옛 기획(NULL)은 지금처럼 모두에게 보인다. `a` 는 plan 별칭(반드시 있어야 한다),
 * `viewer` · `approver` 는 보는 사람 id · 결재권자인가의 파라미터 자리다.
 */
export const planVisibleWhere = (a: string, viewer: string, approver: string): string => planCanSql(a, viewer, approver);

/**
 * 「진행 중 기획」 — 대표를 기다리지도(review) 않고 끝나지도(done) 않은 것 (§69 운영 타일).
 * 결재 대기와 **겹치지 않게** 센다 — 같은 카드의 두 타일이 같은 건을 두 번 세면 합이 거짓이 된다.
 */
export const planRunningWhere = (a = ''): string => `${col(a, 'stage')} IN ('draft', 'rework', 'approved')`;

/** 기준일에 기한이 지났는데 안 끝난 할 일 */
export const todoOverdueWhere = (a = '', d = '$1'): string =>
  `NOT ${col(a, 'done')} AND ${col(a, 'due_on')} IS NOT NULL AND ${col(a, 'due_on')} < ${d}::date`;

/**
 * 수납 전이라 진행이 잠긴 컨설팅 — 계약 5단계의 마지막이 수납이다.
 * running/done 은 제약(cons_paid_stage_check)상 이미 5단계다.
 * **보관 삭제한 건은 뺀다** — 대표 보고 수입이 이미 그 집합으로 뺀다(PB-02). 여기만 세면
 * 카드의 「받은 돈」과 배지가 서로 다른 건을 가리킨다.
 */
export const consLockedWhere = (a = ''): string =>
  `${col(a, 'stage')} = 'contract' AND COALESCE(${col(a, 'contract_step')}, 0) < 5 AND ${col(a, 'deleted_at')} IS NULL`;

/** 아직 안 끝난 컴플레인 — 낱말은 `lib/complaint-words` 한 곳에서 온다 */
export const cplOpenWhere = (a = ''): string => `${col(a, 'stage')} IN (${sqlWordList(CPL_OPEN_STAGES)})`;

export const EXEC_AREA_KEYS = ['money', 'mkt', 'ops', 'consulting', 'complaint', 'lesson'] as const;
export type ExecAreaKey = (typeof EXEC_AREA_KEYS)[number];

export interface ExecAreaDef {
  key: ExecAreaKey;
  /** 화면에 보이는 이름 — 이름의 출처는 하나다 (D-R18) */
  label: string;
  /** 살펴볼 것이 무엇인지 한 줄 (DEV-SPEC §5.3 판정 칸 원문) */
  review: string;
  /** 줄을 누르면 가는 곳 (D-R27 — 결재 흐름은 이동만 한다) */
  go: string;
  /**
   * 살펴볼 것 건수를 세는 SQL. 인자는 **`$1` = 기준일(기간 끝, 포함)** 하나다 —
   * 「지금 남아 있는 것」을 세는 판정이라 시작일이 필요 없다(기한 지난 청구서·안 끝난 컴플레인…).
   * null 이면 이 영역은 SQL 로 세지 않는다 — 마케팅은 정보성이라 판정이 없고(DEV-SPEC §5.3),
   * 수업은 기간 안의 회차를 보는 판정이라 현황판을 재사용한다.
   */
  sql: string | null;
  /**
   * `sql` 이 **보는 사람**을 받는가 (W11 · N-72) — 그러면 `$2` = 보는 사람 id · `$3` = 기획 결재권자인가.
   * 지정 공개 기획은 보이는 사람에게만 센다(`planVisibleWhere`). 모르면 서비스가 닫힌 값(0 · false)을 넣는다.
   */
  viewer?: boolean;
}

export const EXEC_AREAS: readonly ExecAreaDef[] = [
  {
    key: 'money', label: '회계', review: '납부 기한이 지난 청구서 수', go: '/accounting',
    // 기간 끝 시점에 「아직 안 들어왔는데 기한이 지난」 청구서. 완납·취소·초안은 세지 않는다.
    sql: `SELECT count(*)::text n FROM inv WHERE ${invOverdueWhere()}`,
  },
  {
    key: 'mkt', label: '마케팅', review: '없음 (정보성)', go: '/ops',
    sql: null,
  },
  {
    key: 'ops', label: '운영', review: '결재 대기 + 기한 지난 할 일', go: '/ops',
    // 기획은 대표 검토(review) 단계가 「결재 대기」다. 초안은 아직 아무도 기다리지 않는다
    // (drawer 가 초안을 대기함에 올려 배지를 부풀렸던 일이 실제로 있었다 — lib/approval 주석).
    // 지정 공개 기획은 보이는 사람에게만 센다 — 운영 화면에서 안 보이는 기획이 배지로 새지 않게 (N-72)
    viewer: true,
    sql: `SELECT (
            (SELECT count(*) FROM plan p WHERE ${planWaitingWhere('p')} AND ${planVisibleWhere('p', '$2', '$3')})
            + (SELECT count(*) FROM todo WHERE ${todoOverdueWhere()})
          )::text n`,
  },
  {
    key: 'consulting', label: '컨설팅', review: '수납 전이라 진행이 잠긴 계약', go: '/consulting',
    // 계약 5단계의 마지막이 수납이다 — 판정 조각 `consLockedWhere` (보관 삭제 건은 빠진다)
    sql: `SELECT count(*)::text n FROM cons WHERE ${consLockedWhere()}`,
  },
  {
    key: 'complaint', label: '컴플레인', review: '아직 안 끝난 건', go: '/ops',
    /*
     * **한동안 이 줄이 전부를 세고 있었다.** `stage <> 'done'` 이라 적혀 있었는데
     * 저장되는 말은 `received | acting | closed` 라 **'done' 인 행이 하나도 없었다** —
     * 배지가 8(전부)이고 열린 건은 5였다. DBML·entity 주석이 「open | acting | done」이라
     * 선언해 둔 것을 믿은 결과다. 이제 낱말은 `lib/complaint-words` 한 곳에서 온다.
     */
    sql: `SELECT count(*)::text n FROM cpl WHERE ${cplOpenWhere()}`,
  },
  {
    key: 'lesson', label: '수업', review: '교재·안내·줌·리포트가 덜 된 수업', go: '/board',
    sql: null,
  },
];

/**
 * 이 영역의 판정 SQL — **다른 화면이 같은 숫자를 다시 세지 않게** 여기서 꺼내 쓴다.
 *
 * 회계 머리의 「손봐야 할 것」(§52)이 대표 보고의 회계 배지(§69)와 같은 판정이어야 한다.
 * 두 화면이 각자 세면 대표가 보는 두 숫자가 어긋나고 어느 쪽이 맞는지 아무도 모른다.
 */
export function areaCountSql(key: ExecAreaKey): string {
  const area = EXEC_AREAS.find((a) => a.key === key);
  if (!area || !area.sql) throw new Error(`${key} 영역은 SQL 로 세는 판정이 아닙니다`);
  return area.sql;
}

/** 보고서 메모의 6영역 — 「담당 x/6 기재」는 이 키들이 채워졌는지로 센다 (§69 머리) */
export function filledAreas(memo: unknown): number {
  if (!memo || typeof memo !== 'object') return 0;
  const m = memo as Record<string, unknown>;
  return EXEC_AREA_KEYS.filter((k) => typeof m[k] === 'string' && (m[k] as string).trim() !== '').length;
}

/* ══ 기간 — 일일 · 주간 · 월간 시트 머리 (69-1 · 69-4 · D-R18) ═══════════════════════════════
 *
 * 주기 종류를 인자로 받지 않는다 — **기간이 말해 준다**(`monthly` 판과 같은 규약). 하루면 일일,
 * 월요일부터 일요일까지면 주간, 달력 한 달 전체면 월간이다. 입력이 둘이면 둘이 어긋날 수 있다.
 * 날짜 낱말도 서버가 짓는다 — 화면이 제 식으로 지으면 한 화면에 날짜가 두 모양이 된다(69-4).
 */
export type ExecPeriodKind = 'day' | 'week' | 'month' | 'range';

const utc = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const isoOf = (dt: Date): string => dt.toISOString().slice(0, 10);

/** 달력 한 달 전체인가 — 2월처럼 끝날이 다른 달도 제 끝날을 안다 */
export function isWholeMonth(from: string, to: string): boolean {
  if (!from.endsWith('-01')) return false;
  const [y, m] = from.split('-').map(Number);
  // 다음 달 0일 = 이 달의 마지막 날. UTC 로 만들어 표준시 경계에서 하루가 밀리지 않게 한다.
  return to === isoOf(new Date(Date.UTC(y, m, 0)));
}

export function execPeriodKind(from: string, to: string): ExecPeriodKind {
  if (from === to) return 'day';
  if (isWholeMonth(from, to)) return 'month';
  const start = utc(from);
  // 주는 **월요일에 건다** — 결재함 줄과 같은 셈이다(§73 「08-17 ~ 08-23」)
  if (start.getUTCDay() === 1 && isoOf(new Date(start.getTime() + 6 * 86_400_000)) === to) return 'week';
  return 'range';
}

/** 타일 이름 앞말 — 「오늘 입금」 · 「이번 주 접수」 · 「이번 달 수업」 (원본 §69~§71) */
export const EXEC_PERIOD_WORD: Record<ExecPeriodKind, string> = {
  day: '오늘', week: '이번 주', month: '이번 달', range: '이 기간',
};

/** 시트 머리 제목 — 「일일 업무 보고」 (원본 §69 · §70 · §71) */
export const EXEC_SHEET_TITLE: Record<ExecPeriodKind, string> = {
  day: '일일 업무 보고', week: '주간 업무 보고', month: '월간 업무 보고', range: '업무 보고',
};

/** 「26년 8월 21일 금요일」 — 결재함 줄(§73)과 시트 머리(§69)가 같은 함수를 쓴다 */
export function execDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(y).slice(2)}년 ${m}월 ${d}일 ${'일월화수목금토'[utc(iso).getUTCDay()]}요일`;
}

/** 시트 머리·도구 줄의 기간 — 「26년 8월 21일 금요일」 · 「08월 17일 ~ 08월 23일」 · 「2026년 8월」 */
export function execPeriodLabel(kind: ExecPeriodKind, from: string, to: string): string {
  const mmdd = (iso: string) => `${iso.slice(5, 7)}월 ${iso.slice(8, 10)}일`;
  if (kind === 'day') return execDayLabel(from);
  if (kind === 'week') return `${mmdd(from)} ~ ${mmdd(to)}`;
  if (kind === 'month') return `${from.slice(0, 4)}년 ${Number(from.slice(5, 7))}월`;
  return `${from} ~ ${to}`;
}

/* ══ 영역 카드의 한 줄 요약과 타일 (69-8 · 원본 §69~§71) ═══════════════════════════════════
 *
 * 숫자는 서비스가 원장에서 센 **사실**(`ExecAreaFacts`)이고, 문장과 타일은 이 순수 함수가 짓는다 —
 * 화면이 문장을 조립하면 권한(금액 가림)이 화면에 흩어진다(D-R18 · D-R39). 금액 사실은 볼 권한이
 * 없으면 서비스가 **세지 않고** null 로 준다. 그러면 문장에서 금액이 빠지고 타일 값도 null 이다.
 *
 * 펼칠 **줄**(「기한 지난 청구서 2건 펼치기 ▾」)은 여기 없다 — N-67 결정 대기다.
 */
export interface ExecAreaTile {
  key: string;
  label: string;
  /** null = 금액을 볼 권한이 없다 (0 이 아니다) */
  value: number | null;
  unit: '원' | '건';
  sub: string | null;
  /** 붉게 볼 칸인가 — 손봐야 할 것이 있다 */
  alert: boolean;
  /** 값 대신 그릴 글 — 「없음」. 없으면 null */
  display: string | null;
}

export interface ExecAreaDetail {
  headline: string;
  tiles: ExecAreaTile[];
}

export interface ExecAreaFacts {
  money: {
    inCount: number; inSum: number | null;
    unpaidCount: number; unpaidSum: number | null;
    overdueCount: number; overdueSum: number | null;
  };
  mkt: { posts: number; channels: number; topChannel: string | null; topCount: number; comments: number };
  ops: { waiting: number; running: number; meetings: number; openTodos: number };
  consulting: { locked: number; paid: number | null; contract: number | null; nextOn: string | null };
  complaint: { received: number; receivedNames: string[]; open: number };
  lesson: { lessons: number; missing: number; canceled: number; missingMarks: string[] };
}

/** 원화 — 원본 §69 의 「₩8,550,000」 모양. 음수는 「₩-7,674,692」(원본 §71) */
export const krw = (n: number): string => `₩${n.toLocaleString('ko-KR')}`;

/** 현황판 네 판정 축의 낱말 — 순서는 `BOARD_MARK_KEYS` 와 같다(교재 · 안내 · 줌 · 리포트) */
export const EXEC_LESSON_MARK_LABEL: Record<string, string> = {
  book: '교재', guide: '안내', zoom: '줌', report: '리포트',
};

const tile = (
  key: string, label: string, value: number | null, unit: '원' | '건',
  o: { sub?: string | null; alert?: boolean; display?: string | null } = {},
): ExecAreaTile => ({ key, label, value, unit, sub: o.sub ?? null, alert: o.alert ?? false, display: o.display ?? null });

/** 이름 몇 개 — 셋이 넘으면 「외 N명」. 없으면 「—」 (원본 §70 「양찬욱, 고은설」) */
const names = (list: readonly string[]): string =>
  list.length === 0 ? '—' : list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} 외 ${list.length - 3}명`;

export function execAreaDetails(kind: ExecPeriodKind, f: ExecAreaFacts): Record<ExecAreaKey, ExecAreaDetail> {
  const w = EXEC_PERIOD_WORD[kind];
  const m = f.money;
  const unpaidText = m.unpaidSum === null ? `${m.unpaidCount}건` : krw(m.unpaidSum);
  const moneyHead = kind === 'month'
    ? (m.inSum === null
      ? `${w} 입금 ${m.inCount}건 · 못 받은 돈 ${unpaidText}`
      : `${w} ${krw(m.inSum)} 들어왔고 · 못 받은 돈 ${unpaidText}`)
    : m.unpaidCount === 0
      ? '못 받은 돈이 없습니다'
      : `못 받은 돈 ${unpaidText}${m.overdueCount > 0 ? ` · 그중 ${m.overdueCount}건은 기한이 지났습니다` : ''}`;

  const k = f.mkt;
  const mktHead = k.posts === 0
    ? `${w} 올린 것이 없습니다`
    : `${w} ${k.posts}건 올렸습니다${k.topChannel ? ` · ${k.topChannel} ${k.topCount}건이 가장 많습니다` : ''}`;

  const o = f.ops;
  const c = f.consulting;
  const due = c.contract !== null && c.paid !== null ? c.contract - c.paid : null;
  const p = f.complaint;
  const l = f.lesson;
  const lessonHead = l.lessons === 0 && l.canceled === 0
    ? `${w} 수업이 없습니다`
    : `수업 ${l.lessons}건 중 ${l.missing}건 준비 덜 됨${l.canceled > 0 ? ` · 휴강 ${l.canceled}건` : ''}`;

  return {
    money: {
      headline: moneyHead,
      tiles: [
        tile('in', `${w} 입금`, m.inSum, '원', { sub: `${m.inCount}건` }),
        tile('unpaid', '못 받은 돈', m.unpaidSum, '원', { sub: `${m.unpaidCount}건`, alert: m.unpaidCount > 0 }),
        tile('overdue', '기한 지남', m.overdueCount, '건', {
          sub: m.overdueCount > 0 && m.overdueSum !== null ? krw(m.overdueSum) : null,
          alert: m.overdueCount > 0,
          display: m.overdueCount === 0 ? '없음' : null,
        }),
      ],
    },
    mkt: {
      headline: mktHead,
      tiles: [
        // 아무것도 안 올렸으면 붉게 — 원본 §69 「올린 것 0건」 칸이 그렇다
        tile('posts', '올린 것', k.posts, '건', { sub: k.posts > 0 ? `채널 ${k.channels}종` : '—', alert: k.posts === 0 }),
        tile('feedback', '대표 피드백', k.comments, '건', { sub: k.comments > 0 ? '답변 확인' : '없음' }),
      ],
    },
    ops: {
      headline: o.waiting > 0 ? `기획 ${o.waiting}건이 대표 결재를 기다립니다` : '대표 결재를 기다리는 기획이 없습니다',
      tiles: [
        tile('waiting', '결재 대기', o.waiting, '건', { sub: o.waiting > 0 ? '확인 필요' : null, alert: o.waiting > 0 }),
        tile('running', '진행 중 기획', o.running, '건', { sub: `${w} 회의 ${o.meetings}건` }),
        tile('todos', '안 끝난 할 일', o.openTodos, '건'),
      ],
    },
    consulting: {
      headline: c.locked > 0 ? `${c.locked}건이 수납 전이라 진행이 잠겨 있습니다` : '수납 전이라 잠긴 컨설팅이 없습니다',
      tiles: [
        tile('paid', '받은 돈', c.paid, '원', { sub: c.contract === null ? null : `계약 ${krw(c.contract)}` }),
        tile('due', '남은 돈', due, '원', {
          sub: c.nextOn ? `다음 회차 ${c.nextOn.slice(5)}` : '예정 없음',
          alert: (due ?? 0) > 0,
        }),
      ],
    },
    complaint: {
      headline: p.open > 0 ? `${p.open}건이 아직 안 끝났습니다` : '안 끝난 컴플레인이 없습니다',
      tiles: [
        tile('received', `${w} 접수`, p.received, '건', { sub: names(p.receivedNames) }),
        tile('open', '안 끝난 것', p.open, '건', { alert: p.open > 0 }),
      ],
    },
    lesson: {
      headline: lessonHead,
      tiles: [
        tile('lessons', `${w} 수업`, l.lessons, '건', { sub: l.canceled > 0 ? `휴강 ${l.canceled}건` : '휴강 없음' }),
        tile('missing', '준비 안 됨', l.missing, '건', {
          sub: l.missingMarks.length > 0 ? l.missingMarks.join(' · ') : '—',
          alert: l.missing > 0,
        }),
      ],
    },
  };
}

/* ══ §70 지난주 대비 (N-66 의 주간 · D-R44 · 테스트 시나리오 K-107 · O-146) ══════════════════════
 *
 * 원본 §70 규칙 「직전 주(shift(d1,-7)~shift(d2,-7))를 같은 방식으로 집계해 비교」 · 동작 「머리 지표에 ▲▼ 증감률」.
 * 원본 §69 일간 · §71 월간 머리에는 비교가 없다 — **주간에만** 선다(월간 비교 기준은 N-66 결정 대기로 남는다).
 * 낱말은 컷의 세 칸이 정한다: 「지난주 ▼ 100%」(₩0 ← 지난주엔 있었다) · 「지난주 ▲ 25%」 · 「지난주 신규」(0 → 생김).
 * 같은 값(0 과 0 포함)은 컷에 없다 — 「지난주와 같음」으로 적는다. 0 과 0 을 「신규」라 적으면 없던 일이 생긴 것처럼 읽힌다.
 * 어느 쪽이든 모르면(금액을 볼 권한이 없어 세지 않았다) 비교하지 않는다 — 비율도 금액의 정보다(D-R39).
 */
export function execWeekDelta(cur: number | null, prev: number | null): string | null {
  if (cur === null || prev === null) return null;
  if (cur === prev) return '지난주와 같음';
  if (prev === 0) return '지난주 신규';
  const pct = Math.round((Math.abs(cur - prev) / Math.abs(prev)) * 100);
  return `지난주 ${cur > prev ? '▲' : '▼'} ${pct}%`;
}

/* ══ 영역 카드의 펼칠 줄 (N-67 · D-R44 · 테스트 시나리오 K-111) ═══════════════════════════════════
 *
 * 원본 §69~§71 카드마다 「기한 지난 청구서 2건 펼치기 ▾」 — **배지와 같은 집합**의 줄이다. 0 이면 그 줄 자체가 없다
 * (§69 마케팅 · §71 회계 카드). 수업은 배지가 17(일) · 43(주) · 155(월)인데 펼칠 줄은 늘 「8건」이다 — 줄은 여덟에서 끊는다.
 * 줄 모양은 영역마다 다르지만 서버가 공통 {title · sub · go} 로 접는다(N-67 ①) — 카드는 한 모양만 그린다.
 * 「펼치기 ▾」는 동작 낱말이라 화면이 붙인다. go 는 그 줄의 원본 화면이다(D-R27 — 대표 보고 안에서 처리하지 않는다).
 */
export const EXEC_AREA_ITEM_LIMIT = 8;

export interface ExecAreaItem {
  key: string;
  title: string;
  sub: string | null;
  go: string;
}

/** 펼칠 줄 머리의 명사 — 원본 컷 여섯 카드의 글자 그대로. 기간 앞말은 마케팅만 붙는다(「이번 주 올린 것 4건」) */
const EXEC_AREA_ITEMS_WORD: Record<ExecAreaKey, (w: string) => string> = {
  money: () => '기한 지난 청구서',
  mkt: (w) => `${w} 올린 것`,
  ops: () => '결재 대기 · 기한 지난 할 일',
  consulting: () => '수납 전이라 잠긴 컨설팅',
  complaint: () => '안 끝난 컴플레인',
  lesson: () => '준비가 덜 된 수업',
};

/** 「기한 지난 청구서 2건」 — 줄 수를 센다(원본 수업 카드: 배지 17 · 줄 8건). 줄이 없으면 null(펼칠 것이 없다) */
export function execAreaItemsLabel(key: ExecAreaKey, kind: ExecPeriodKind, n: number): string | null {
  return n === 0 ? null : `${EXEC_AREA_ITEMS_WORD[key](EXEC_PERIOD_WORD[kind])} ${n}건`;
}

/** 현황판 한 줄 중 펼칠 줄이 읽는 칸 — `BoardRowDto` 의 부분이다 */
export interface ExecLessonRow {
  serId: number;
  date: string;
  startAt: string;
  subName?: string | null;
  kindName?: string | null;
  canceled: boolean;
  missing: number;
  marks: ReadonlyArray<{ key: string; done: boolean; na: boolean }>;
}

/**
 * 수업 카드의 펼칠 줄 — 현황판 줄에서 **배지(`missingCount`)와 같은 거르기**(휴강 아님 · 덜 된 것)로 여덟.
 * 판정은 현황판(`clChk()`)이 이미 했다 — 여기서는 덜 된 축의 낱말만 붙인다(교재 · 안내 · 줌 · 리포트 차례).
 */
export function execLessonItems(rows: readonly ExecLessonRow[]): ExecAreaItem[] {
  return rows
    .filter((r) => !r.canceled && r.missing > 0)
    .slice(0, EXEC_AREA_ITEM_LIMIT)
    .map((r) => ({
      key: `lesson-${r.serId}-${r.date}`,
      title: `${r.date.slice(5)} ${r.startAt} ${r.subName ?? r.kindName ?? '수업'}`,
      sub: r.marks.filter((m) => !m.na && !m.done).map((m) => EXEC_LESSON_MARK_LABEL[m.key] ?? m.key).join(' · ') || null,
      // 그 날의 현황판(일별)을 곧장 연다 — 현황판이 `?date=` 를 읽는다 (7-3 ① · 목록 전체로 보내지 않는다)
      go: `/board?date=${r.date}`,
    }));
}

/**
 * §71 상담 퍼널의 셋째 줄 — 원본 컷과 슬라이드 글 「유입 → 1차 → 2차·진단 → 등록」(71-5 · D-R44).
 * 「2차 · 진단」은 2차 상담에 **닿은** 건이다. 2차 대기는 세지 않는다 — 같은 컷의 「어디서 놓쳤나」가 「2차 안 옴」을 따로
 * 세므로, 기다리다 오지 않은 건을 2차에 닿았다고 세면 두 판이 서로 다른 말을 한다.
 */
export const EXEC_FUNNEL_SECOND_LABEL = '2차 · 진단';
