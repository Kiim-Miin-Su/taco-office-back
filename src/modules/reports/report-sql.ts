/** @file-guide
 * 목적: report-sql.ts — REPORT_DATE_SQL, REPORT_CANCELED_SQL (util)
 * 책임/재사용: 리포트 목록·하루 발송·주간 묶음이 같은 「실제 수업일」·「취소」 판정을 쓰게 하는 SQL 조각 한 벌이다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { kstDateOf } from '../../lib/sql';

/**
 * 목록·발송 묶음·주간 묶음·표시가 같은 **실제 수업일**을 쓴다. 회차 없는 보존 REP만 원래 키로 대체한다.
 * `rep r` · `ser_occ o` 별칭을 전제한다.
 */
export const REPORT_DATE_SQL = `COALESCE(${kstDateOf('lower(o.span)')}, r.on_date)`;

/**
 * 일정 취소·출결 취소는 같은 판정이다. 새 발송(하루 · 주간)에서 빼되 보존 상세/이력을 지우지 않는다.
 * `ser_occ o` · `att a` 별칭을 전제한다.
 */
export const REPORT_CANCELED_SQL = `(COALESCE(o.canceled, false) OR COALESCE(a.result = 'canceled', false))`;
