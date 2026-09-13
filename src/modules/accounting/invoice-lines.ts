/** @file-guide
 * 목적: invoice-lines.ts — InvoiceLineRow, Queryer, invoiceLines, linesTotal, RepriceVerdict 등 (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 수업료 청구서의 **줄을 만드는 단 하나의 자리** (§53 발행 · §54 계산 · 재가격 도구가 같이 쓴다).
 *
 * 원문 슬라이드 54 — 「데이터 RATE(단가), **STURATE(학생별 예외)**」 ·
 * 「규칙 **그룹 수업은 인원이 늘면 1인 단가가 내려가고 총액은 올라갑니다**」 ·
 * 「연동 **청구서 생성 시 이 계산 결과를 씁니다**」.
 *
 * C63 이 이 규칙을 발행 질의에 넣었고, 그 뒤 **재가격 도구가 같은 계산을 한 번 더 하게 됐다.**
 * 두 곳이 각자 SQL 을 들면 그 순간 「낼 때의 금액」과 「다시 셀 때의 금액」이 갈린다 (D-R22).
 * 그래서 질의를 여기 한 벌만 두고 둘이 부른다.
 *
 * 세는 규칙(D-R37) — 취소된 회차와 「그날만 빠진」 학생은 빼고 센다(D-R21).
 * 달은 회차의 **시작 시각을 KST 로 본 달**이다 (D-R12).
 */
import { kstMonthOf } from '../../lib/sql';

export interface InvoiceLineRow {
  sub_key: string | null;
  label: string;
  n: number;
  unit_price: number | null;
}

/** 질의 하나를 실행할 수 있는 것 — EntityManager 든 QueryRunner 든 받는다 */
export type Queryer = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

const SQL = `
  WITH priced AS (
    SELECT se.sub_key,
           COALESCE(sb.name, k.name) AS label,
           COALESCE(
             (SELECT su.unit_price FROM sturate su
               WHERE su.student_id = $1
                 AND (su.kind_key IS NULL OR su.kind_key = se.kind_key)
                 AND su.from_date <= o.on_date
               ORDER BY su.kind_key NULLS LAST, su.from_date DESC
               LIMIT 1),
             (SELECT r.unit_price FROM rate r
               WHERE r.kind_key = se.kind_key
                 AND (r.sub_key IS NULL OR r.sub_key = se.sub_key)
                 AND r.heads <= (SELECT count(*) FROM ser_stu x WHERE x.ser_id = se.id)
                 AND r.from_date <= o.on_date
               ORDER BY r.sub_key NULLS LAST, r.heads DESC, r.from_date DESC
               LIMIT 1)
           )::int AS unit_price
      FROM ser_occ o
      JOIN ser se     ON se.id = o.ser_id
      JOIN kind k     ON k.key = se.kind_key
      LEFT JOIN sub sb ON sb.key = se.sub_key
      JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ss.student_id = $1
     WHERE NOT o.canceled
       AND ${kstMonthOf('lower(o.span)')} = $2
       AND NOT EXISTS (
             SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
              WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND xo.student_id = $1)
  )
  SELECT sub_key, label, count(*)::int AS n, unit_price
    FROM priced
   GROUP BY sub_key, label, unit_price
   ORDER BY label, unit_price`;

/**
 * 그 학생 그 달의 수업료 줄. **단가가 다르면 줄이 갈린다** —
 * 「몇 번에 얼마」가 한 줄에서 읽혀야 한다(달 중간에 단가가 오른 경우가 그 자리다).
 * 단가표에 없는 과목은 `unit_price` 가 null 로 온다 — 부르는 쪽이 거절한다(0 원으로 꾸미지 않는다).
 */
export async function invoiceLines(m: Queryer, studentId: number, yearMonth: string): Promise<InvoiceLineRow[]> {
  return (await m.query(SQL, [studentId, yearMonth])) as InvoiceLineRow[];
}

/** 줄의 합 — 「총액」을 두 곳에서 더하지 않는다 */
export const linesTotal = (lines: InvoiceLineRow[]): number =>
  lines.reduce((sum, l) => sum + l.n * Number(l.unit_price), 0);

/**
 * 다시 낼 것인가 — 재가격 도구(`scripts/invoice-reprice.ts`)의 판정 (대표 결정 2026-09-13 · N-38).
 *
 * **「미납 건만 다시 낸다」.** 교정 금액은 대개 내려가므로, 이미 받은 돈이 새 금액보다 많으면
 * 완납이던 건이 **과납**으로 바뀐다. 환불인지 다음 달 이월인지는 장부의 문제라 도구가 고르지 않는다.
 *
 * 스크립트 안에 두지 않고 여기 두는 이유는 하나다 — **회귀가 부를 수 있어야** 한다.
 */
export type RepriceVerdict = 'same' | 'reissue' | 'reissue_move_pay' | 'overpaid';

export function repriceVerdict(oldAmount: number, newAmount: number, paid: number): RepriceVerdict {
  if (newAmount === oldAmount) return 'same';
  if (paid > newAmount) return 'overpaid';
  return paid === 0 ? 'reissue' : 'reissue_move_pay';
}
