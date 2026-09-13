/** @file-guide
 * 목적: invoice-reprice.ts (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * C63 이전에 발행된 **수업료 청구서를 교정 단가로 다시 낸다** (대표 결정 2026-09-13 · N-38).
 *
 *   npm run invoice:reprice                     — 무엇이 바뀌는지만 본다 (쓰기 0)
 *   npm run invoice:reprice -- --month=2026-09  — 한 달만 본다
 *   npm run invoice:reprice -- --apply          — 실제로 다시 낸다
 *
 * **왜 필요한가.** C63 이전의 발행 질의는 인원 구간(`rate.heads`)도 학생 예외(`sturate`)도
 * 안 봤다. 2인 수업이 1인 단가로 청구되는 식이었고, 실측으로 한 학생 한 달에 약 93% 과다였다.
 *
 * **대표 결정: 「미납 건만 다시 낸다」.** 그래서 이 도구는 네 갈래로 나눈다 —
 *
 *   ① 받은 돈 0 · 금액 다름         → 취소(void) 후 재발행
 *   ② 일부납 · 받은 돈 ≤ 새 금액    → 재발행하고 **입금 줄을 새 청구서로 옮긴다**
 *   ③ 받은 돈 > 새 금액 (과납이 됨)  → **손대지 않는다.** 이미 오간 돈이라 사람이 정한다
 *   ④ 금액 같음                     → 손댈 것 없음
 *
 * ③ 을 자동으로 처리하지 않는 이유는 하나다 — 교정 금액이 **내려가는** 방향이라,
 * 완납이던 건이 과납으로 바뀐다. 환불인지 다음 달 이월인지는 장부의 문제고 도구가 고를 일이 아니다.
 *
 * **컨설팅비 청구서는 대상이 아니다.** 그 줄은 수업 회차에서 나오지 않는다 (C58 — `cons_pay`).
 * 취소된 청구서(void)도 건드리지 않는다.
 *
 * 재발행은 **새 행을 넣는 것**이고 옛 행은 `void` 로 남는다 — 지운 것이 아니라 이력이다.
 *
 * ── 먼저 읽을 것 ────────────────────────────────────────────────────────
 * 이 도구는 「단가만 고쳐 끼우는」 것이 **아니다.** 지금 있는 회차로 **줄을 처음부터 다시 만든다.**
 * 그래서 시드·이관으로 들어온 청구서처럼 **애초에 회차에서 계산되지 않은 금액**은 차이가 크게 난다
 * (오르는 것도 있다). 원문 §54 의 「연동: 청구서 생성 시 이 계산 결과를 씁니다」가 그 기준이지만,
 * **차이가 단가 버그 때문인지 원래 손으로 적은 금액이어서인지는 이 도구가 구분하지 못한다.**
 * `--apply` 전에 목록을 반드시 눈으로 보고, 필요하면 `--month` 로 좁혀서 돌린다.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { describeTarget } from '../src/lib/target';
import {
  invoiceLines, linesTotal, repriceVerdict,
  type InvoiceLineRow, type RepriceVerdict,
} from '../src/modules/accounting/invoice-lines';
import { INV_TYPE_LABEL } from '../src/modules/accounting/accounting.dto';

dotenv.config({ path: '.env.local' });
dotenv.config();

const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;
const esc = String.fromCharCode(27);
const C = {
  d: `${esc}[2m`, r: `${esc}[31m`, g: `${esc}[32m`, y: `${esc}[33m`, b: `${esc}[1m`, x: `${esc}[0m`,
};

interface Row {
  id: string; student_id: string; name: string; year_month: string; inv_type: string;
  amount: number; paid_amount: number; state: string;
}

/** 단가표에 없는 과목은 도구가 따로 센다 — 0 원으로 꾸미지 않는다 */
type Verdict = RepriceVerdict | 'no_rate';

interface Planned { row: Row; verdict: Verdict; newAmount: number; lines: InvoiceLineRow[] }

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const monthArg = process.argv.find((a) => a.startsWith('--month='))?.slice('--month='.length);
  await ds.initialize();
  console.log(`\n대상: ${describeTarget(process.env.DATABASE_URL).label}`);
  if (monthArg) console.log(`달: ${monthArg}`);
  console.log(apply
    ? `${C.y}${C.b}실제로 다시 냅니다 (--apply)${C.x}`
    : `${C.d}무엇이 바뀌는지만 봅니다 — 쓰기 0. 실제로 내려면 --apply${C.x}`);
  console.log(`${C.d}줄을 처음부터 다시 만듭니다 — 손으로 적힌 금액이던 청구서는 차이가 큽니다(오르는 것도 있습니다).${C.x}\n`);

  const q = ds.createQueryRunner();
  await q.connect();
  const rows = (await q.query(
    `SELECT i.id, i.student_id, s.name, i.year_month, i.inv_type,
            i.amount, i.paid_amount, i.state::text AS state
       FROM inv i JOIN stu s ON s.id = i.student_id
      WHERE i.inv_type = 'tuition' AND i.state <> 'void'
        AND ($1::text IS NULL OR i.year_month = $1)
      ORDER BY i.year_month, s.name`,
    [monthArg ?? null],
  )) as Row[];

  const seen: Record<Verdict, number> = { reissue: 0, reissue_move_pay: 0, overpaid: 0, same: 0, no_rate: 0 };
  let deltaSum = 0;
  const plan: Planned[] = [];

  for (const row of rows) {
    const lines = await invoiceLines(q, Number(row.student_id), row.year_month);
    if (lines.length === 0 || lines.some((l) => l.unit_price === null)) {
      seen.no_rate += 1;
      plan.push({ row, verdict: 'no_rate', newAmount: 0, lines });
      continue;
    }
    const newAmount = linesTotal(lines);
    const old = Number(row.amount);
    const verdict: Verdict = repriceVerdict(old, newAmount, Number(row.paid_amount));
    seen[verdict] += 1;
    if (verdict !== 'same') deltaSum += newAmount - old;
    plan.push({ row, verdict, newAmount, lines });
  }

  const mark: Record<Verdict, string> = {
    reissue: `${C.g}다시 냄${C.x}`,
    reissue_move_pay: `${C.g}다시 냄 · 입금 이전${C.x}`,
    overpaid: `${C.r}과납 — 손대지 않음${C.x}`,
    same: `${C.d}그대로${C.x}`,
    no_rate: `${C.y}단가 없음 — 손대지 않음${C.x}`,
  };
  for (const { row, verdict, newAmount } of plan) {
    if (verdict === 'same') continue;
    const d = newAmount - Number(row.amount);
    console.log(
      `  ${row.year_month}  ${row.name.padEnd(8)} ${INV_TYPE_LABEL[row.inv_type] ?? row.inv_type}  `
      + `${won(Number(row.amount))} → ${won(newAmount)}  (${d > 0 ? '+' : ''}${won(d)})  `
      + `받음 ${won(Number(row.paid_amount))}  ${mark[verdict]}`,
    );
  }

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  청구서 ${rows.length}장 중 — 다시 냄 ${seen.reissue + seen.reissue_move_pay} · `
    + `과납 ${seen.overpaid} · 단가 없음 ${seen.no_rate} · 그대로 ${seen.same}`);
  console.log(`  금액 차이 합계 ${deltaSum > 0 ? '+' : ''}${won(deltaSum)}`);
  console.log(`  ${C.d}차이가 단가 버그 때문인지 원래 손으로 적은 금액이어서인지는 이 도구가 구분하지 못합니다 — 목록을 눈으로 보세요.${C.x}`);
  if (seen.overpaid > 0) {
    console.log(`  ${C.r}과납 ${seen.overpaid}건은 손대지 않았습니다${C.x} — 이미 받은 돈이 새 금액보다 많습니다. 환불인지 이월인지는 사람이 정합니다.`);
  }
  if (seen.no_rate > 0) {
    console.log(`  ${C.y}단가 없음 ${seen.no_rate}건${C.x} — 그 달 수업이 없거나 단가표에 없는 과목이 있습니다. 0원으로 내지 않습니다.`);
  }

  if (!apply) {
    console.log(`\n${C.d}쓰기 0 — 실제로 내려면 npm run invoice:reprice -- --apply${C.x}\n`);
    await q.release();
    await ds.destroy();
    return;
  }

  let done = 0;
  for (const { row, verdict, newAmount, lines } of plan) {
    if (verdict !== 'reissue' && verdict !== 'reissue_move_pay') continue;
    await q.startTransaction();
    try {
      /*
       * 옛 행은 지우지 않는다 — void 로 남겨 이력이 끊기지 않게 한다.
       * 받은 합은 **0 으로 내린다**: 입금 줄을 아래에서 새 청구서로 옮기므로, 그대로 두면
       * 취소된 행에 **뒷받침 없는 합계**가 남는다. 내가 C63 에서 지적한 바로 그 모양이다 (D-R37).
       */
      await q.query(`UPDATE inv SET state = 'void', paid_amount = 0 WHERE id = $1`, [row.id]);
      const [made] = (await q.query(
        `INSERT INTO inv (student_id, year_month, inv_type, title, amount, state,
                          issued_on, due_on, created_by, paid_amount)
         SELECT student_id, year_month, inv_type, title, $2, $3::inv_state_t,
                issued_on, due_on, created_by, $4
           FROM inv WHERE id = $1
         RETURNING id`,
        [row.id, newAmount, Number(row.paid_amount) === 0 ? row.state : 'partial', Number(row.paid_amount)],
      )) as Array<{ id: string }>;
      const newId = Number(made.id);
      for (const [i, l] of lines.entries()) {
        await q.query(
          `INSERT INTO inv_line (inv_id, sub_key, label, count, unit_price, amount, seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [newId, l.sub_key, l.label, l.n, l.unit_price, l.n * Number(l.unit_price), i],
        );
      }
      // 입금 줄이 옛 청구서에 매달린 채로 남으면 그 돈이 장부에서 붕 뜬다
      await q.query(`UPDATE pay SET inv_id = $1 WHERE inv_id = $2`, [newId, row.id]);
      await q.commitTransaction();
      done += 1;
    } catch (e) {
      await q.rollbackTransaction();
      console.log(`  ${C.r}실패${C.x} ${row.year_month} ${row.name} — ${(e as Error).message}`);
      throw e;
    }
  }
  console.log(`\n${C.g}다시 낸 청구서 ${done}장${C.x} — 옛 청구서는 취소(void)로 남습니다.\n`);
  await q.release();
  await ds.destroy();
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
