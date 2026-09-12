/** @file-guide
 * 목적: exec-areas.ts — EXEC_AREAS, ExecAreaKey, areaCountSql (util)
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

import { INV_OPEN } from './rules';
import { sqlWordList } from './sql';

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
}

export const EXEC_AREAS: readonly ExecAreaDef[] = [
  {
    key: 'money', label: '회계', review: '납부 기한이 지난 청구서 수', go: '/accounting',
    // 기간 끝 시점에 「아직 안 들어왔는데 기한이 지난」 청구서. 완납·취소·초안은 세지 않는다.
    sql: `SELECT count(*)::text n FROM inv
           WHERE state IN (${sqlWordList(INV_OPEN)}) AND due_on IS NOT NULL AND due_on < $1::date`,
  },
  {
    key: 'mkt', label: '마케팅', review: '없음 (정보성)', go: '/ops',
    sql: null,
  },
  {
    key: 'ops', label: '운영', review: '결재 대기 + 기한 지난 할 일', go: '/ops',
    // 기획은 대표 검토(review) 단계가 「결재 대기」다. 초안은 아직 아무도 기다리지 않는다
    // (drawer 가 초안을 대기함에 올려 배지를 부풀렸던 일이 실제로 있었다 — lib/approval 주석).
    sql: `SELECT (
            (SELECT count(*) FROM plan WHERE stage = 'review')
            + (SELECT count(*) FROM todo WHERE NOT done AND due_on IS NOT NULL AND due_on < $1::date)
          )::text n`,
  },
  {
    key: 'consulting', label: '컨설팅', review: '수납 전이라 진행이 잠긴 계약', go: '/consulting',
    // 계약 5단계의 마지막이 수납이다. running/done 은 제약(cons_paid_stage_check)상 이미 5단계다.
    sql: `SELECT count(*)::text n FROM cons
           WHERE stage = 'contract' AND COALESCE(contract_step, 0) < 5`,
  },
  {
    key: 'complaint', label: '컴플레인', review: '아직 안 끝난 건', go: '/ops',
    sql: `SELECT count(*)::text n FROM cpl WHERE stage <> 'done'`,
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
