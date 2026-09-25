/** @file-guide
 * 목적: golive-reset.ts (script)
 * 책임/재사용: 검사/생성/실행 도구의 책임만 소유한다. 대상 경로와 실행 권한을 확인하고 실패를 성공으로 기록하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * **운영 전환 — 시험 자료 · 시험 계정 지우기** (대표 지시 2026-09-26 「테스트 끝나고 운영시 record 삭제」 · W8).
 *
 *   npm run golive:reset                                                        — 무엇을 지우는지만 본다 (쓰기 0)
 *   npm run golive:reset -- --keep-email=<대표 이메일>                            — 남길 대표까지 넣어 본다 (쓰기 0)
 *   npm run golive:reset -- --apply --confirm=<지금 DB 이름> --keep-email=<대표 이메일>  — 실제로 지운다
 *
 * 남기는 것: 설정 표(수업 종류 · 과목 · 강의실 · 시간대 · 줌 계정 · GPA 항목 · 휴일 · 안내 틀)와 스키마 이력(migrations),
 * 그리고 **활성 대표 계정 하나**. 그 대표는 초기 비밀번호 + 첫 설정(아이디·비밀번호 변경 · 휴대폰·이메일 확인)으로 되돌린다.
 * 나머지 표는 전부 비운다 — 분류 · 순서 · 남는 표 정리는 `src/lib/golive-reset.ts` 한 곳이 정한다.
 *
 * **안전장치** — ① 기본은 미리 보기이고 그때는 읽기 전용 트랜잭션이다 ② `--apply` 는 `--confirm` 에 **지금 DB 이름**을
 * 정확히 적어야 하고 `--keep-email` 이 활성 대표여야 한다 ③ 모르는 인자는 거절한다 ④ 전부 한 트랜잭션 — 중간에 하나라도
 * 어긋나면 통째로 되돌린다 ⑤ 연결 문자열 · 비밀번호 · 초기 비밀번호는 찍지 않는다(호스트와 DB 이름만).
 *
 * 종료 코드 — 0: 미리 보기 끝 · 지우기 끝 / 2: 거절(인자 · 대표 · 남는 표 막힘) / 1: 오류(되돌림).
 * **반드시 백업을 먼저 뜬다** — 되돌릴 방법은 백업뿐이다(구현 기록의 실행 순서).
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import ds from '../src/data-source';
import { describeTarget } from '../src/lib/target';
import { applyGoLive, applyRefusal, parseGoLiveArgs, planGoLive, type GoLivePlan } from '../src/lib/golive-reset';

dotenv.config({ path: '.env.local' });
dotenv.config();

const esc = String.fromCharCode(27);
const C = { d: `${esc}[2m`, r: `${esc}[31m`, g: `${esc}[32m`, y: `${esc}[33m`, b: `${esc}[1m`, x: `${esc}[0m` };
const n = (v: number): string => v.toLocaleString('ko-KR');

function printPlan(plan: GoLivePlan): void {
  console.log(`\n${C.b}남기는 표 (설정)${C.x}`);
  console.log(`  ${plan.keep.map((k) => `${k.table} ${n(k.rows)}`).join(' · ')}`);
  console.log(`\n${C.b}비우는 표 (지우는 순서)${C.x}`);
  const nonzero = plan.empty.filter((e) => e.rows > 0);
  for (const e of nonzero) console.log(`  ${e.table.padEnd(18)} ${n(e.rows).padStart(8)}줄`);
  const zero = plan.empty.length - nonzero.length;
  if (zero > 0) console.log(`  ${C.d}이미 빈 표 ${zero}개${C.x}`);
  console.log(`\n${C.b}계정(staff)${C.x}  지금 ${n(plan.staff.rows)} · 지움 ${n(plan.staff.delete)} · 남김 ${n(plan.staff.keep)}`);
  console.log(`  활성 대표: ${plan.activeCeos.length ? plan.activeCeos.map((c) => `#${c.id} ${c.name} (${c.emailMasked})`).join(' · ') : `${C.r}없음${C.x}`}`);
  if (plan.keptCeo) {
    console.log(`  ${C.g}남길 대표: #${plan.keptCeo.id} ${plan.keptCeo.name} (${plan.keptCeo.emailMasked})${C.x} — 초기 비밀번호 + 첫 설정으로 되돌립니다`);
  } else {
    console.log(`  ${C.y}남길 대표: 아직 안 정함${C.x} — --keep-email=<활성 대표의 이메일>`);
  }
  if (plan.keepEmailProblem) console.log(`  ${C.r}${plan.keepEmailProblem}${C.x}`);
  if (plan.fixes.length) {
    console.log(`\n${C.b}남는 줄이 지워질 줄을 가리킴${C.x}`);
    const word = { set_null: '비움(NULL)', reassign_ceo: '남길 대표로', abort: `${C.r}멈춤${C.x}` } as const;
    for (const f of plan.fixes) console.log(`  ${f.table}.${f.column} → ${f.refTable}  ${n(f.rows)}줄 · ${word[f.action]}`);
  }
  const total = plan.empty.reduce((s, e) => s + e.rows, 0) + plan.staff.delete;
  const kept = plan.keep.reduce((s, k) => s + k.rows, 0) + plan.staff.keep;
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  지움 ${n(total)}줄 (표 ${plan.empty.length}개 + 계정 ${n(plan.staff.delete)}) · 남김 ${n(kept)}줄`);
}

async function main(): Promise<void> {
  const args = parseGoLiveArgs(process.argv.slice(2));
  if (args.unknown.length > 0) {
    console.error(`${C.r}모르는 인자입니다: ${args.unknown.join(' ')}${C.x} — --apply · --confirm=<DB 이름> · --keep-email=<이메일> 만 받습니다`);
    process.exitCode = 2;
    return;
  }
  const target = describeTarget(process.env.DATABASE_URL);
  if (!target.host) {
    console.error(`${C.r}${target.label}${C.x}`);
    process.exitCode = 2;
    return;
  }

  await ds.initialize();
  const q = ds.createQueryRunner();
  await q.connect();
  try {
    await q.startTransaction();
    // 미리 보기는 **읽기 전용** 트랜잭션이다 — 실수로 쓰는 줄이 섞여도 DB 가 거절한다
    if (!args.apply) await q.query('SET TRANSACTION READ ONLY');
    const plan = await planGoLive(q, args.keepEmail);

    console.log(`\n${C.b}운영 전환 — 시험 자료 · 시험 계정 지우기${C.x}`);
    // 연결 문자열은 찍지 않는다 — 호스트와 DB 이름만
    console.log(`대상: ${target.label} · 지금 DB 이름 "${plan.database}"`);
    console.log(args.apply
      ? `${C.y}${C.b}실제로 지웁니다 (--apply)${C.x}`
      : `${C.d}무엇을 지우는지만 봅니다 — 쓰기 0. 실제로 지우려면 --apply --confirm=${plan.database} --keep-email=<대표 이메일>${C.x}`);
    printPlan(plan);

    if (!args.apply) {
      await q.rollbackTransaction();
      if (plan.blockers.length) console.log(`\n${C.r}이대로는 지울 수 없습니다 — ${plan.blockers.join(' · ')}${C.x}`);
      console.log(`\n${C.d}쓰기 0 — 백업을 먼저 뜬 뒤 --apply 로 지웁니다.${C.x}\n`);
      return;
    }

    const refusal = applyRefusal(args, plan);
    if (refusal) {
      await q.rollbackTransaction();
      console.error(`\n${C.r}거절 — ${refusal}${C.x}\n아무것도 바꾸지 않았습니다.\n`);
      process.exitCode = 2;
      return;
    }

    const res = await applyGoLive(q, args.keepEmail!);
    await q.commitTransaction();
    const rows = res.deleted.reduce((s, d) => s + d.rows, 0);
    console.log(`\n${C.g}${C.b}지웠습니다${C.x} — 표 ${res.deleted.length}개에서 ${n(rows)}줄 · 계정 ${n(res.staffDeleted)}개`);
    if (res.fixed.length) console.log(`  남는 줄 정리 ${res.fixed.length}칸 (${res.fixed.map((f) => `${f.table}.${f.column}`).join(' · ')})`);
    console.log(`  남은 계정: 대표 #${plan.keptCeo!.id} ${plan.keptCeo!.name} — 초기 비밀번호로 로그인하면 첫 설정 화면으로 갑니다.\n`);
  } catch (e) {
    if (q.isTransactionActive) await q.rollbackTransaction();
    // 오류 문장만 — 연결 정보나 값은 싣지 않는다
    console.error(`\n${C.r}실패 — 통째로 되돌렸습니다: ${(e as Error).message}${C.x}\n`);
    process.exitCode = 1;
  } finally {
    await q.release();
    await ds.destroy();
  }
}

main().catch((e: unknown) => { console.error((e as Error)?.message ?? e); process.exitCode = 1; });
