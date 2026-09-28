/** @file-guide
 * 목적: exec.service.ts — ExecService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { REPORT_UNWRITTEN_CANDIDATE_DB } from '../../lib/rules';
import { NOTI_TITLE } from '../../lib/noti';
import {
  consLockedWhere, cplOpenWhere, EXEC_AREA_ITEM_LIMIT, EXEC_AREA_KEYS, EXEC_AREAS, EXEC_FUNNEL_SECOND_LABEL, EXEC_LESSON_MARK_LABEL,
  EXEC_PERIOD_WORD, EXEC_SHEET_TITLE, execAreaDetails, execAreaItemsLabel, execDayLabel, execLessonItems, execPeriodKind,
  execAsOf, execPeriodLabel, execWeekDelta, filledAreas, invDueSql, invOpenWhere, invOverdueWhere, isWholeMonth, krw,
  planRunningWhere, planWaitingWhere, todoOverdueWhere,
  type ExecAreaFacts, type ExecAreaItem, type ExecAreaKey, type ExecPeriodKind,
} from '../../lib/exec-areas';
// W11 · N-72 지정 공개 기획 판정(planCan 한 곳) · N-81 영역 담당 · N-97 회수 감사
import { planVisibleWhere } from '../../lib/exec-areas';
import { audit } from '../../lib/audit';
import { mktChannelLabel, mktTitle } from '../../lib/marketing-words';
import { cplAreaLabel, cplStageLabel } from '../../lib/complaint-words';
import { csCan, type ConsShare } from '../../lib/rules';
import { addDays, todayKst } from '../../lib/kst';
import { consultingTypeLabel } from '../consulting/consulting.rules';
import { BOARD_MARK_KEYS } from '../board/board.rules';
import type { BoardDto } from '../board/board.dto';
import {
  INTAKE_FAIL_STOPS, INTAKE_FAIL_STOP_UNSET, INTAKE_FUNNEL_STAGES, INTAKE_STAGE_LABEL, intakeFailStop, leadLogLastStageSql,
} from '../../lib/intake-words';
import {
  blocksSelfApproval, labelOf, RPT_TYPE_LABEL, SELF_APPROVAL_CODE, selfApprovalSqlGuard, toApState,
} from '../../lib/approval';
import { BoardService } from '../board/board.service';

/**
 * §73 결재 단추를 서버가 판정하기 위해 필요한 「보는 사람」.
 *
 * 선택 인자인 이유는 이 서비스를 직접 새로 만들어 쓰는 DB 스위트가 여럿이라서다.
 * **안 주면 단추를 닫는다** — 모르는 쪽으로 열면 눌렀을 때 서버가 거절해 그 자리가 다음 불일치가 된다.
 */
export type ExecViewer = {
  id: number;
  canApprove: boolean;
  /**
   * §76 canHide — 비공개 컨설팅 열람. 펼칠 줄(N-67)이 컨설팅 줄을 **공개 범위(csCan) 안에서만** 싣기 위해 받는다 —
   * 컨설팅 화면에서 안 보이는 건의 학생 이름이 대표 보고 줄로 새면 안 된다. 모르면 없는 것으로 본다.
   */
  canHide?: boolean;
  /**
   * 기획 결재권자인가(`canCeoApprovePlan` · 대표 판정) — 지정 공개 기획이 보이는 셋 중 하나다(W11 · N-72 · planCan).
   * 배지 · 운영 타일 · 펼칠 줄이 운영 화면과 같은 판정으로 센다. 모르면 닫는다(지정 공개 기획은 안 보인다).
   */
  canApprovePlan?: boolean;
  /** 영역 담당을 바꿀 수 있는가(`canCeoSetExecOwner` · 대표 판정 · W11 · N-81). 모르면 닫는다 */
  canSetOwner?: boolean;
};

/** 지정 공개 기획 판정의 재료 — 보는 사람 id · 결재권자인가. 모르면 닫힌 값(0 · false)이다 (N-72) */
const planViewerParams = (viewer?: ExecViewer): [number, boolean] => [viewer?.id ?? 0, viewer?.canApprovePlan === true];

/** 회수가 막히는 이유 — 단추(canWithdraw)와 쓰기(409 · 403)가 같은 판정을 쓴다 (N-97 · S5) */
const rptWithdrawBlocked = (state: string, sentBy: unknown, viewerId: number): { code: string; message: string } | null => {
  if (state !== 'sent') return { code: 'RPT_NOT_SENT', message: '올라간 보고만 회수할 수 있습니다' };
  if (sentBy === null || sentBy === undefined || Number(sentBy) !== viewerId) {
    return { code: 'RPT_NOT_SUBMITTER', message: '올린 사람만 회수할 수 있습니다' };
  }
  return null;
};
import type {
  ExecAreaMemoDto, ExecAreaOwnerDto, ExecDto, ExecInboxDto, ExecMemoWriteDto, ExecMonthlyDto,
  ExecReportWriteResultDto, ExecReviewDto, ExecStatDto, ExecSubmitDto,
} from './exec.dto';

/** 영역 배지 한 칸 — 결재함 줄은 이것만 센다(카드 타일은 이 기간의 시트에서만 만든다) */
type AreaCount = { key: ExecAreaKey; label: string; review: string; count: number; go: string };

/**
 * 기간 안에 들어온 돈 — 청구서 입금(`pay`) + **컨설팅 수납(`cons_pay`)** (PB-02 · 71-3).
 * 컨설팅 계약금은 청구서 없이 `cons_pay` 에만 들어온다 — `pay` 만 세면 그 달 이익이 계약금만큼 과소였다.
 * 두 원장은 **같은 돈을 담지 않는다**: 「청구서로 전환」은 남은 돈으로만 내고(N-33) 전환 뒤에는
 * `cons_pay` 를 막는다(PB-03). 보관 삭제한 건은 §28 회계 표와 같은 집합으로 뺀다.
 *
 * 머리의 「매출 (입금)」·「오늘 들어온 돈」과 회계 카드의 「입금」 타일이 **이 한 문장**을 읽는다.
 * `$3` 이 false 면 금액을 **세지 않는다**(null) — 건수는 금액이 아니라 센다.
 */
const REVENUE_SQL = `
  SELECT CASE WHEN $3::boolean THEN
           (COALESCE((SELECT sum(amount) FROM pay WHERE paid_on BETWEEN $1::date AND $2::date),0)
          + COALESCE((SELECT sum(p.amount) FROM cons_pay p JOIN cons c ON c.id = p.cons_id
                       WHERE c.deleted_at IS NULL AND p.paid_on BETWEEN $1::date AND $2::date),0))::bigint
         END AS total,
         ((SELECT count(*) FROM pay WHERE paid_on BETWEEN $1::date AND $2::date)
        + (SELECT count(*) FROM cons_pay p JOIN cons c ON c.id = p.cons_id
            WHERE c.deleted_at IS NULL AND p.paid_on BETWEEN $1::date AND $2::date))::int AS n`;

/**
 * 기간에 들어온 문의 · 올린 마케팅 — 머리 「신규 문의」·「마케팅 게시」와 **주간 지난주 값**이 같은 문장을 읽는다
 * (원본 §70 규칙 「직전 주를 **같은 방식으로** 집계해 비교」 · N-66 주간). `$1`·`$2` = 기간.
 */
const LEADS_IN_SQL = `SELECT count(*)::text n FROM lead WHERE created_at::date BETWEEN $1::date AND $2::date`;
const POSTS_IN_WHERE = `on_date BETWEEN $1::date AND $2::date`;

/**
 * 여섯 칸을 **언제나 다** 만든다 — 안 적은 칸은 빈 문자열이다.
 * 화면이 칸 목록을 들면 순서(D-R25)와 낱말(D-R18)이 서버와 갈린다.
 */
function areaMemos(memo: unknown): ExecAreaMemoDto[] {
  const m = (memo && typeof memo === 'object' ? memo : {}) as Record<string, unknown>;
  return EXEC_AREA_KEYS.map((key) => ({
    key,
    memo: typeof m[key] === 'string' ? (m[key] as string) : '',
  }));
}
import { drawnDateOf, kstAt, serStuOn } from '../../lib/sql';

/**
 * **아직 고칠 수 있는 보고의 상태** — 낱말은 여기 하나다 (S5 · D-R18).
 *
 * 쓰기 둘(`writeMemo` 의 `ON CONFLICT … WHERE`, `submit` 의 앞선 검사)과 **단추 판정**이 같은 배열을
 * 본다. 전에는 쓰기 두 곳에 `['draft','rej']` 가 손으로 적혀 있었고 화면은 역할 권한만 봐서,
 * 이미 올린 보고에서도 단추가 선 채 눌러야만 409 `RPT_LOCKED` 가 났다.
 */
const WRITABLE_RPT_STATES: readonly string[] = ['draft', 'rej'];

/**
 * 막힌 이유 한 문장 (S5 · D-R22).
 *
 * 세 곳이 서로 다르게 말하고 있었다 — 저장은 「이미 올린 보고는 고칠 수 없습니다…」, 올리기는
 * 「이미 올린 보고입니다」, 화면 단추는 아무 말도 안 했다. **같은 잠금에 문장이 셋이면** 사람은
 * 서로 다른 세 가지 일이 일어났다고 읽는다. 이제 단추도 저장도 올리기도 이 함수를 부른다.
 *
 * 결재가 끝난 보고(`ok`)와 아직 결재를 기다리는 보고(`sent`)는 **다음에 할 일이 다르다** —
 * 하나는 끝났고 하나는 반려를 기다리면 다시 고칠 수 있다. 그래서 문장도 둘이다.
 */
const rptLockedMessage = (state: string): string =>
  (state === 'ok'
    ? '결재가 끝난 보고는 고칠 수 없습니다'
    : '이미 올린 보고는 고칠 수 없습니다. 반려된 뒤에 다시 적어 주세요');

type R = Record<string, unknown>;

/** 쿼리를 부를 수 있는 것 — 저장소 또는 트랜잭션의 EntityManager (같은 트랜잭션에 쓰기 · LOG · NOTI 를 묶는다) */
type Runner = { query(sql: string, p?: unknown[]): Promise<unknown> };

/**
 * §69 대표 보고.
 *
 * 현황판과 같은 규칙이다 — **집계는 저장하지 않는다** (D-R4).
 * 보고서 본문(RPT)만 원장에 남고, 숫자는 요청 때마다 다시 센다.
 *
 * 금액 칸은 **응답에서 뺀다**(null). 화면에서만 감추면 네트워크 탭에 그대로 보인다 (D-R39).
 */
@Injectable()
export class ExecService {
  constructor(
    @InjectRepository(Lead) private readonly anyRepo: Repository<Lead>,
    /** 수업 영역의 「덜 된 수업」은 현황판 판정을 **그대로** 쓴다 — 같은 숫자를 두 곳에서 세지 않는다 */
    private readonly board: BoardService,
  ) {}

  /** 오늘(KST) — 「지금 남아 있는 것」의 기준일은 기간 끝과 오늘 중 앞선 날이다(`execAsOf` · H-79). 시험이 바꿔 끼운다 */
  today: () => string = () => todayKst();

  private async one(sql: string, p: unknown[] = []): Promise<number> {
    const r = (await this.anyRepo.query(sql, p)) as Array<{ n: string }>;
    return Number(r[0]?.n ?? 0);
  }

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  /**
   * 쓰기 + `RETURNING` 의 한 줄. **UPDATE 는 모양이 다르다** —
   * TypeORM 의 `query()` 가 `UPDATE … RETURNING` 에서는 `[rows, affected]` 를 돌려주므로
   * 그냥 구조 분해하면 **0건일 때도 빈 배열이 잡혀 truthy 가 된다**(한 번 속았다).
   */
  private async row<T = R>(sql: string, p: unknown[] = [], run: Runner = this.anyRepo): Promise<T | null> {
    const out = (await run.query(sql, p)) as unknown;
    const rows = Array.isArray(out) && Array.isArray(out[0]) ? (out[0] as T[]) : (out as T[]);
    return rows.length ? rows[0] : null;
  }


  /**
   * §69 6영역 — 살펴볼 것을 센다. 정의는 `lib/exec-areas.ts` 한 곳에 있다.
   * 수업만 현황판(`clChk()`)의 판정을 그대로 가져온다.
   */
  private async areaCounts(from: string, to: string, board?: BoardDto, viewer?: ExecViewer, asOf = to): Promise<AreaCount[]> {
    const out: AreaCount[] = [];
    for (const a of EXEC_AREAS) {
      let count = 0;
      if (a.key === 'lesson') {
        count = (board ?? await this.board.range({ from, to })).missingCount;
      } else if (a.sql) {
        // 기준일을 안 쓰는 판정(안 끝난 컴플레인 등)에 인자를 넘기면 bind 오류가 난다 ·
        // 보는 사람을 받는 판정(운영 — 지정 공개 기획 · N-72)은 `$2` · `$3` 을 더 받는다
        count = await this.one(a.sql, a.viewer ? [asOf, ...planViewerParams(viewer)] : a.sql.includes('$1') ? [asOf] : []);
      }
      out.push({ key: a.key, label: a.label, review: a.review, count, go: a.go });
    }
    return out;
  }

  /**
   * §69 영역 카드의 **사실** — 한 줄 요약과 타일을 짓는 재료 (69-8).
   *
   * 「무엇을 세는가」는 `lib/exec-areas` 의 판정 조각(`invOverdueWhere` …)을 배지와 **같이** 쓴다 —
   * 타일의 「기한 지남 2건」과 배지 「2」가 같은 WHERE 에서 나온다. 금액은 볼 권한이 없으면 세지 않는다(null).
   * 「지금 남아 있는 것」(못 받은 돈 · 안 끝난 할 일 …)은 기준일(`to`)의 판정이고, 「이 기간에 일어난 것」
   * (입금 · 접수 · 올린 것 · 회의)은 기간 안만 센다.
   */
  private async areaFacts(
    from: string, to: string, canSeeAmounts: boolean, board: BoardDto,
    revenue: { total: number | null; n: number },
    viewer?: ExecViewer,
    asOf = to,
  ): Promise<ExecAreaFacts> {
    const [inv] = await this.q(
      `SELECT count(*) FILTER (WHERE ${invOpenWhere()})::int AS unpaid_n,
              CASE WHEN $2::boolean THEN COALESCE(sum(amount - paid_amount) FILTER (WHERE ${invOpenWhere()}),0) END::bigint AS unpaid_sum,
              count(*) FILTER (WHERE ${invOverdueWhere()})::int AS overdue_n,
              CASE WHEN $2::boolean THEN COALESCE(sum(amount - paid_amount) FILTER (WHERE ${invOverdueWhere()}),0) END::bigint AS overdue_sum
         FROM inv`,
      [asOf, canSeeAmounts],
    );
    const [mkt] = await this.q(
      `SELECT count(*)::int AS posts, count(DISTINCT channel)::int AS channels,
              (SELECT count(*) FROM mfb WHERE kind = 'comment' AND (at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $1::date AND $2::date)::int AS comments
         FROM mkt WHERE ${POSTS_IN_WHERE}`,
      [from, to],
    );
    // 「blog 1건이 가장 많습니다」 — 같은 수면 채널 코드 순(매번 같은 답이어야 한다)
    const [top] = await this.q(
      `SELECT channel, count(*)::int AS n FROM mkt WHERE ${POSTS_IN_WHERE}
        GROUP BY channel ORDER BY n DESC, channel LIMIT 1`,
      [from, to],
    );
    // 기획 두 타일은 배지와 같은 판정이다 — 지정 공개 기획은 보이는 사람에게만 센다 (N-72)
    const [ops] = await this.q(
      `SELECT (SELECT count(*) FROM plan p WHERE ${planWaitingWhere('p')} AND ${planVisibleWhere('p', '$3', '$4')})::int AS waiting,
              (SELECT count(*) FROM plan p WHERE ${planRunningWhere('p')} AND ${planVisibleWhere('p', '$3', '$4')})::int AS running,
              (SELECT count(*) FROM mtrec WHERE on_date BETWEEN $1::date AND $2::date)::int AS meetings,
              (SELECT count(*) FROM todo WHERE NOT done)::int AS open_todos`,
      [from, to, ...planViewerParams(viewer)],
    );
    const [cons] = await this.q(
      `SELECT count(*)::int AS locked,
              CASE WHEN $2::boolean THEN COALESCE(sum(c.amount),0) END::bigint AS contract,
              CASE WHEN $2::boolean THEN COALESCE(sum((SELECT COALESCE(sum(p.amount),0) FROM cons_pay p WHERE p.cons_id = c.id)),0) END::bigint AS paid,
              (SELECT to_char(min(s.on_date),'YYYY-MM-DD') FROM cons_sess s JOIN cons c2 ON c2.id = s.cons_id
                WHERE ${consLockedWhere('c2')} AND s.on_date > $1::date) AS next_on
         FROM cons c WHERE ${consLockedWhere('c')}`,
      [asOf, canSeeAmounts],
    );
    const [cpl] = await this.q(
      `SELECT count(*) FILTER (WHERE ${cplOpenWhere('c')})::int AS open,
              count(*) FILTER (WHERE (c.created_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $1::date AND $2::date)::int AS received,
              COALESCE(array_agg(DISTINCT st.name ORDER BY st.name) FILTER (
                WHERE (c.created_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $1::date AND $2::date AND st.name IS NOT NULL), '{}') AS names
         FROM cpl c LEFT JOIN stu st ON st.id = c.student_id`,
      [from, to],
    );
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      money: {
        inCount: revenue.n, inSum: revenue.total,
        unpaidCount: Number(inv?.unpaid_n ?? 0), unpaidSum: num(inv?.unpaid_sum),
        overdueCount: Number(inv?.overdue_n ?? 0), overdueSum: num(inv?.overdue_sum),
      },
      mkt: {
        posts: Number(mkt?.posts ?? 0), channels: Number(mkt?.channels ?? 0),
        topChannel: top ? mktChannelLabel(String(top.channel)) : null, topCount: Number(top?.n ?? 0),
        comments: Number(mkt?.comments ?? 0),
      },
      ops: {
        waiting: Number(ops?.waiting ?? 0), running: Number(ops?.running ?? 0),
        meetings: Number(ops?.meetings ?? 0), openTodos: Number(ops?.open_todos ?? 0),
      },
      consulting: {
        locked: Number(cons?.locked ?? 0), paid: num(cons?.paid), contract: num(cons?.contract),
        nextOn: (cons?.next_on as string | null) ?? null,
      },
      complaint: {
        received: Number(cpl?.received ?? 0),
        receivedNames: (cpl?.names as string[] | undefined) ?? [],
        open: Number(cpl?.open ?? 0),
      },
      lesson: {
        lessons: board.summary.lessons,
        missing: board.missingCount,
        canceled: board.summary.canceled,
        // 덜 된 축의 낱말 — 현황판 네 축의 순서 그대로 (원본 §69 「교재 · 안내 · 줌」)
        missingMarks: BOARD_MARK_KEYS
          .filter((key) => (board.summary.marks.find((mk) => mk.key === key)?.missing ?? 0) > 0)
          .map((key) => EXEC_LESSON_MARK_LABEL[key]),
      },
    };
  }

  /**
   * §70 지난주 값 — **같은 문장을 −7일 기간에 한 번 더** 부른다(원본 §70 규칙 「직전 주(shift(d1,-7)~shift(d2,-7))를
   * 같은 방식으로 집계해 비교」 · N-66 의 주간 · D-R44). 입금은 금액이라 볼 권한이 없으면 세지 않는다(null).
   */
  private async weekPrev(
    from: string, to: string, canSeeAmounts: boolean,
  ): Promise<{ revenue: number | null; leads: number; posts: number }> {
    const pf = addDays(from, -7);
    const pt = addDays(to, -7);
    const [rev] = await this.q(REVENUE_SQL, [pf, pt, canSeeAmounts]);
    const leads = await this.one(LEADS_IN_SQL, [pf, pt]);
    const posts = await this.one(`SELECT count(*)::text n FROM mkt WHERE ${POSTS_IN_WHERE}`, [pf, pt]);
    const revenue = canSeeAmounts && rev?.total !== null && rev?.total !== undefined ? Number(rev.total) : null;
    return { revenue, leads, posts };
  }

  /**
   * §69~§71 카드의 **펼칠 줄** (N-67 · D-R44 · K-111) — 배지와 **같은 판정 조각**으로 뽑고 여덟에서 끊는다.
   *
   * - 금액은 볼 권한이 없으면 세지도 싣지도 않는다(`CASE WHEN $n::boolean`) — 줄 부제에서도 빠지고, 누가 못 냈는지
   *   (학생 이름)도 싣지 않는다. 금액 권한이 없는 사람에게 「누가 안 냈는가」는 금액과 같은 정보다(D-R39).
   * - 컨설팅 줄은 **공개 범위(csCan) 안에서만** 싣는다 — 컨설팅 화면에서 안 보이는 건의 학생이 여기로 새지 않게.
   * - go 는 원본 화면이다(D-R27). 줄 하나를 곧장 여는 질의를 쓴다 — 회계 `invId` · 기획 `plan` · 컨설팅 `id` ·
   *   컴플레인 `cpl` · 현황판 `date`(W11 · 7-3 ① · 대상 화면이 읽는다). 그런 질의가 없는 목록(마케팅 · 할 일)은 그 목록으로 보낸다.
   */
  private async areaItems(
    from: string, to: string, canSeeAmounts: boolean, board: BoardDto, viewer?: ExecViewer, asOf = to,
  ): Promise<Record<ExecAreaKey, ExecAreaItem[]>> {
    const L = EXEC_AREA_ITEM_LIMIT;
    const md = (iso: string) => iso.slice(5);
    // 기한 · 지난 날 · 차례는 **지금 기한**(`invDueSql` — 분납이면 못 채운 가장 이른 회차의 예정일)이다. 거르는 조각
    // (`invOverdueWhere`)이 이미 그 날로 판정하므로 줄에 적는 날도 같아야 한다 — `inv.due_on`(분납이면 마지막 회차)을 적으면
    // 첫 회차로 연체인 청구서가 「−N일 지남」이 됐다 (N-79 · W11 A' 후속)
    const inv = await this.q(
      `SELECT i.id, i.title, st.name AS student, to_char(cd.due,'YYYY-MM-DD') AS due_on, ($1::date - cd.due)::int AS late,
              CASE WHEN $2::boolean THEN (i.amount - i.paid_amount) END::bigint AS left_amount
         FROM inv i LEFT JOIN stu st ON st.id = i.student_id
        CROSS JOIN LATERAL (SELECT ${invDueSql('i')} AS due) cd
        WHERE ${invOverdueWhere('i')}
        ORDER BY cd.due, i.id LIMIT ${L}`,
      [asOf, canSeeAmounts],
    );
    const mkt = await this.q(
      `SELECT id, title, channel, item, to_char(on_date,'YYYY-MM-DD') AS on_date
         FROM mkt WHERE ${POSTS_IN_WHERE} ORDER BY on_date, id LIMIT ${L}`,
      [from, to],
    );
    // 결재 대기 기획이 먼저, 그다음 기한 지난 할 일(오래된 기한 먼저) — 배지 「결재 대기 + 기한 지난 할 일」의 두 조각 그대로
    const ops = await this.q(
      `SELECT * FROM (
         SELECT 'plan' AS kind, p.id, p.title, NULL::text AS due_on, 0 AS late FROM plan p
          WHERE ${planWaitingWhere('p')} AND ${planVisibleWhere('p', '$2', '$3')}
         UNION ALL
         SELECT 'todo', t.id, t.title, to_char(t.due_on,'YYYY-MM-DD'), ($1::date - t.due_on)::int FROM todo t WHERE ${todoOverdueWhere('t')}
       ) x ORDER BY (kind = 'todo'), due_on NULLS FIRST, id LIMIT ${L}`,
      [asOf, ...planViewerParams(viewer)],
    );
    const cons = await this.q(
      `SELECT c.id, c.cons_type, c.contract_step, c.share, c.owner_id,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              (SELECT string_agg(st.name, ', ' ORDER BY st.name) FROM cons_stu cs JOIN stu st ON st.id = cs.student_id
                WHERE cs.cons_id = c.id) AS names
         FROM cons c WHERE ${consLockedWhere('c')}
        ORDER BY c.created_at, c.id`,
      [viewer?.id ?? 0],
    );
    const cpl = await this.q(
      `SELECT c.id, c.area, c.stage, st.name AS student, to_char(c.created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS got_on
         FROM cpl c LEFT JOIN stu st ON st.id = c.student_id
        WHERE ${cplOpenWhere('c')} ORDER BY c.created_at, c.id LIMIT ${L}`,
    );
    const late = (r: R) => `기한 ${md(String(r.due_on))} · ${Number(r.late)}일 지남`;
    return {
      money: inv.map((r) => ({
        key: `inv-${Number(r.id)}`,
        title: canSeeAmounts && r.student ? `${String(r.student)} · ${String(r.title)}` : String(r.title),
        sub: r.left_amount === null || r.left_amount === undefined ? late(r) : `${krw(Number(r.left_amount))} · ${late(r)}`,
        // 그 청구서를 곧장 연다 — 회계 청구서 탭이 이미 읽는 `invId` 를 쓴다 (7-3 ①)
        go: `/accounting?tab=inv&invId=${Number(r.id)}`,
      })),
      mkt: mkt.map((r) => ({
        key: `mkt-${Number(r.id)}`,
        title: mktTitle(r.title as string | null, String(r.channel), String(r.item)),
        sub: `${mktChannelLabel(String(r.channel))} · ${md(String(r.on_date))}`,
        go: '/ops?tab=mkt',
      })),
      ops: ops.map((r) => (r.kind === 'plan'
        ? { key: `plan-${Number(r.id)}`, title: String(r.title), sub: '결재 대기', go: `/ops?tab=plan&plan=${Number(r.id)}` }
        : { key: `todo-${Number(r.id)}`, title: String(r.title), sub: late(r), go: '/ops?tab=todo' })),
      consulting: cons
        .filter((r) => csCan(String(r.share) as ConsShare, {
          isOwner: viewer !== undefined && Number(r.owner_id) === viewer.id,
          isPicked: r.is_picked === true,
          canHide: viewer?.canHide === true,
          canMoney: canSeeAmounts,
        }))
        .slice(0, L)
        .map((r) => ({
          key: `cons-${Number(r.id)}`,
          title: `${(r.names as string | null) ?? '학생 미정'} · ${consultingTypeLabel(String(r.cons_type))}`,
          sub: `계약 ${r.contract_step === null ? '—' : Number(r.contract_step)}/5단계 · 수납 전`,
          go: `/consulting?id=${Number(r.id)}`,
        })),
      complaint: cpl.map((r) => ({
        key: `cpl-${Number(r.id)}`,
        title: `${(r.student as string | null) ?? '학생 미정'} · ${cplAreaLabel(String(r.area))}`,
        sub: `${cplStageLabel(String(r.stage))} · 접수 ${md(String(r.got_on))}`,
        go: `/ops?tab=complaint&cpl=${Number(r.id)}`,
      })),
      lesson: execLessonItems(board.rows),
    };
  }

  /**
   * 시트 머리 지표 넷 — **기간마다 원문 칸이 다르다** (69-6 · 70-1 · 71-1).
   * 새로 세는 것은 없다: 영역 사실 · 수입 · 현황판 · 기존 통계에서 **같은 값**을 가져온다
   * (결재 대기·안 끝난 컴플레인은 운영·컴플레인 카드 타일과 같은 수다 — N-19).
   * 주간만 입금 · 신규 문의 · 마케팅 게시를 **지난주와 견준다**(원본 §70 「지난주 ▼ 100%」 · N-66 의 주간 · D-R44).
   * 일간 · 월간 컷의 머리에는 비교가 없다 — 월간의 비교 기준은 N-66 결정 대기로 남는다.
   */
  private static head(
    kind: ExecPeriodKind, f: ExecAreaFacts, board: BoardDto, stats: ExecStatDto[],
    prev: { revenue: number | null; leads: number; posts: number } | null = null,
  ): ExecStatDto[] {
    const w = EXEC_PERIOD_WORD[kind];
    const stat = (key: string) => stats.find((x) => x.key === key)?.value ?? null;
    /** 지난주와 견준 부제 — 비교하지 않는 기간이면 둘 다 null */
    const vs = (cur: number | null, p: number | null | undefined): Pick<ExecStatDto, 'prev' | 'note'> =>
      (prev ? { prev: p ?? null, note: execWeekDelta(cur, p ?? null) } : { prev: null, note: null });
    const revenue: ExecStatDto = { key: 'revenue', label: kind === 'day' ? '오늘 들어온 돈' : `${w} 입금`, value: f.money.inSum, unit: '원', money: true, total: null, note: null, prev: null };
    if (kind === 'month') {
      const margin = stat('margin');
      return [
        { ...revenue, label: '매출 (입금)' },
        { key: 'payout', label: '강사료', value: stat('payout'), unit: '원', money: true, total: null, note: null, prev: null },
        { key: 'expense', label: '지출', value: stat('expense'), unit: '원', money: true, total: null, note: null, prev: null },
        // 이익률은 「이익」 칸의 부제다 — 원본 §71 「−268%」. 수입이 0 이면 비율이 없다(null)
        { key: 'profit', label: '이익', value: stat('profit'), unit: '원', money: true, total: null, note: margin === null ? null : `${margin}%`, prev: null },
      ];
    }
    if (kind === 'week') {
      return [
        { ...revenue, ...vs(revenue.value ?? null, prev?.revenue) },
        { key: 'leads', label: '신규 문의', value: stat('leads'), unit: '건', money: false, total: null, ...vs(stat('leads'), prev?.leads) },
        { key: 'posts', label: '마케팅 게시', value: f.mkt.posts, unit: '건', money: false, total: null, ...vs(f.mkt.posts, prev?.posts) },
        // 「수업 준비 6/49 · 다 된 것」 — 현황판의 판정(네 축이 다 선 수업 / 수업)을 그대로 쓴다 (C85-c). 원본은 이 칸을 견주지 않는다
        { key: 'prep', label: '수업 준비', value: board.summary.doneLessons, unit: '건', money: false, total: board.summary.lessons, note: '다 된 것', prev: null },
      ];
    }
    return [
      revenue,
      { key: 'unpaid', label: '못 받은 돈', value: f.money.unpaidSum, unit: '원', money: true, total: null, note: null, prev: null },
      { key: 'waiting', label: '결재 대기', value: f.ops.waiting, unit: '건', money: false, total: null, note: null, prev: null },
      { key: 'complaints', label: '안 끝난 컴플레인', value: f.complaint.open, unit: '건', money: false, total: null, note: null, prev: null },
    ];
  }

  /** RPT 키 날짜를 사람이 읽는 기간으로 (§73 줄 제목) */
  /**
   * 주는 **월요일에 건다** — 원문 §73 의 주간 줄이 「08-17 ~ 08-23」(월~일)이다.
   *
   * 전에는 `RPT.on_date` 를 그대로 주의 시작으로 썼다. 그런데 그 날짜가 수요일이면
   * 결재함 줄은 「09-09 ~ 09-15」라 적고, 눌러서 열린 주간 화면은 **월요일부터 세어**
   * 「09-07 ~ 09-13」을 보여 준다 — **누른 것과 열린 것이 다른 주**였다.
   * 기간을 정하는 자리를 서버 하나로 두고 화면은 따라온다 (D-R37).
   */
  private static mondayOf(onDate: string): string {
    const [y, m, d] = onDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    // 일요일(0)은 그 주의 끝이라 엿새를 뺀다
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  }

  private static periodLabel(rptType: string, onDate: string): string {
    const [y, m] = onDate.split('-').map(Number);
    if (rptType === 'month') return `${y}년 ${m}월`;
    if (rptType === 'week') {
      const span = ExecService.periodRange('week', onDate);
      return `${span.from.slice(5)} ~ ${span.to.slice(5)}`;
    }
    // 날짜 낱말은 시트 머리와 같은 함수다 (69-4) — 한 화면에 날짜가 두 모양이면 안 된다
    return execDayLabel(onDate);
  }

  /** RPT 키 날짜 → 그 주기가 덮는 실제 기간 */
  private static periodRange(rptType: string, onDate: string): { from: string; to: string } {
    const [y, m] = onDate.split('-').map(Number);
    const iso = (dt: Date) => dt.toISOString().slice(0, 10);
    if (rptType === 'month') return { from: `${onDate.slice(0, 7)}-01`, to: iso(new Date(Date.UTC(y, m, 0))) };
    if (rptType === 'week') {
      // 월요일에 건다 — 위 주석
      const mon = ExecService.mondayOf(onDate);
      const [my, mm, md] = mon.split('-').map(Number);
      return { from: mon, to: iso(new Date(Date.UTC(my, mm - 1, md + 6))) };
    }
    return { from: onDate, to: onDate };
  }

  /* ══ §69~§71 쓰기 — 「숫자만으로는 모를 것」과 서명 (C85-a) ══════════ */

  /**
   * RPT 키 날짜 — 주기마다 **한 건**이어야 하므로 날짜를 정규화한다 (D-R23).
   * 화면이 아무 날짜나 보내도 여기서 같은 키로 모인다: 주간=그 주 월요일 · 월간=그 달 1일.
   */
  private static keyDate(rptType: string, onDate: string): string {
    if (rptType === 'month') return `${onDate.slice(0, 7)}-01`;
    if (rptType === 'week') return ExecService.mondayOf(onDate);
    return onDate;
  }

  /** 한 건을 읽어 쓰기 응답 모양으로 — 화면이 상태·기재 수를 다시 세지 않는다 (D-R37) */
  private async writeResult(id: number): Promise<ExecReportWriteResultDto> {
    const row = await this.row(
      `SELECT r.id, r.state, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.memo,
              sb.name AS sent_by_name, rb.name AS reviewed_by_name
         FROM rpt r
         LEFT JOIN staff sb ON sb.id = r.sent_by
         LEFT JOIN staff rb ON rb.id = r.reviewed_by
        WHERE r.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException({ code: 'RPT_NOT_FOUND', message: '보고를 찾을 수 없습니다' });
    return {
      id: Number(row.id), state: String(row.state), onDate: String(row.on_date),
      filled: filledAreas(row.memo),
      sentByName: (row.sent_by_name as string) ?? null,
      reviewedByName: (row.reviewed_by_name as string) ?? null,
    };
  }

  /**
   * 작성 중 저장 — 영역 메모를 **덮어쓰지 않고 합친다.**
   *
   * 여섯 칸을 여러 사람이 나눠 적는 화면이라(원본 §69 의 칸마다 담당 이름이 다르다) 보낸
   * 칸만 바꾼다. 안 보낸 칸을 지우면 한 사람이 저장할 때마다 남의 줄이 사라진다.
   *
   * 이미 올린 보고(`sent`)나 결재된 보고(`ok`)는 못 고친다 — 대표가 본 것과 저장된 것이
   * 달라지면 서명이 거짓이 된다. 반려(`rej`)는 고칠 수 있다(그러라고 반려한 것이다).
   */
  async saveMemo(dto: ExecMemoWriteDto, actorId: number): Promise<ExecReportWriteResultDto> {
    const key = ExecService.keyDate(dto.rptType, dto.onDate);
    const patch: Record<string, string> = {};
    for (const m of dto.memos) patch[m.key] = m.memo.trim();

    const row = await this.row(
      `INSERT INTO rpt (rpt_type, on_date, memo, state)
            VALUES ($1, $2::date, $3::jsonb, 'draft')
       ON CONFLICT (rpt_type, on_date) DO UPDATE
          SET memo = rpt.memo || EXCLUDED.memo
        WHERE rpt.state IN (${WRITABLE_RPT_STATES.map((w) => `'${w}'`).join(',')})
       RETURNING id, state`,
      [dto.rptType, key, JSON.stringify(patch)],
    );
    if (!row) {
      /*
       * 0행이면 **왜 막혔는지 다시 읽는다** (S1 의 RPT 쓰기와 같은 자리).
       * `ON CONFLICT … WHERE` 는 무엇에 걸렸는지 말해 주지 않는다 — 상태를 모른 채
       * 한 문장으로 뭉뚱그리면 결재가 끝난 보고에도 「반려된 뒤에 다시 적어 주세요」라 답한다.
       */
      const locked = await this.row(
        `SELECT state FROM rpt WHERE rpt_type = $1 AND on_date = $2::date`, [dto.rptType, key],
      );
      throw new ConflictException({ code: 'RPT_LOCKED', message: rptLockedMessage(String(locked?.state ?? '')) });
    }
    // 누가 적었는지는 LOG 가 갖는다 — RPT 의 서명 두 칸은 「올린 사람」과 「대표 승인」이다
    await this.log(actorId, Number(row.id), 'memo', { areas: dto.memos.map((m) => m.key) });
    return this.writeResult(Number(row.id));
  }

  /**
   * 「대표께 올리기」 — **한 줄이라도 적어야 올라간다** (D-R14).
   *
   * 숫자는 저장하지 않으므로(D-R4) 보고에서 사람이 더한 것은 메모뿐이다. 하나도 없으면
   * 그 보고는 집계 화면과 다를 것이 없다.
   */
  async submit(dto: ExecSubmitDto, actorId: number): Promise<ExecReportWriteResultDto> {
    const key = ExecService.keyDate(dto.rptType, dto.onDate);
    const found = await this.row(
      `SELECT id, state, memo FROM rpt WHERE rpt_type = $1 AND on_date = $2::date`,
      [dto.rptType, key],
    );
    if (!found) {
      throw new NotFoundException({ code: 'RPT_NOT_FOUND', message: '아직 적은 것이 없습니다' });
    }
    if (!WRITABLE_RPT_STATES.includes(String(found.state))) {
      // 저장과 같은 문장이다 — 한 잠금에 말이 둘이면 두 가지 일로 읽힌다 (S5)
      throw new ConflictException({ code: 'RPT_LOCKED', message: rptLockedMessage(String(found.state)) });
    }
    if (filledAreas(found.memo) === 0) {
      throw new ConflictException({
        code: 'RPT_EMPTY',
        message: '한 줄이라도 적어야 올릴 수 있습니다 — 숫자는 이 화면이 이미 보여 줍니다',
      });
    }
    await this.q(
      `UPDATE rpt SET state = 'sent', sent_at = now(), sent_by = $2,
                      reviewed_at = NULL, reviewed_by = NULL, reject_reason = NULL
        WHERE id = $1`,
      [found.id, actorId],
    );
    await this.log(actorId, Number(found.id), 'submit', { state: 'sent' });
    /**
     * **올리면 대표가 안다** (원문 K-104 · O-145 「제출 후 대표에게 알림」).
     *
     * 지금까지 올리기는 행만 바꾸고 아무도 부르지 않았다 — 대표는 결재함을 **직접 열어야** 올라온 줄
     * 알았다. 받는 사람은 이미 정해져 있다(`lib/approval` 의 `APPROVAL_FLOW_RECIPIENT.rpt = 'ceo'`)
     * 이고 갈 곳도 결재 흐름이 쓰는 링크 그대로다. **자기에게는 보내지 않는다** — 대표가 제 보고를
     * 제가 올리는 일이 흔하고, 그때 제 수신함에 제 글이 쌓이면 읽지 않게 된다 (C38 · C99 와 같은 규약).
     */
    await this.q(
      `INSERT INTO noti (to_id, from_id, body, link, category, title)
       SELECT id, $1, $2, $3, 'request', $4 FROM staff WHERE active AND role = 'ceo' AND id <> $1`,
      [
        actorId,
        `${labelOf(RPT_TYPE_LABEL, dto.rptType)} 보고가 올라왔습니다 — ${key}`,
        `/exec?view=${dto.rptType}&date=${key}&rpt=${Number(found.id)}`,
        NOTI_TITLE.execSubmitted,
      ],
    );
    return this.writeResult(Number(found.id));
  }

  /**
   * §73 결재 — **대표만** 한다 (`lib/approval` 의 `APPROVAL_FLOW_RECIPIENT.rpt = 'ceo'`).
   * 반려는 사유가 반드시 있다 (D-R13) — 왜 돌아왔는지 모르면 다시 올릴 수가 없다.
   *
   * W11 · N-97 — 결과를 **올린 사람에게 알린다**(원문 슬라이드 73 「제출·승인·반려마다 LOG 기록 + 상대에게 NOTI」).
   * 결재자가 곧 올린 사람이면 보내지 않는다(자기에게 알리지 않는 공용 규약 · C38 · C99). 올린 사람을 모르는 옛 보고(N-25)와
   * 그만둔 사람에게도 보내지 않는다. RPT · LOG · NOTI 는 **한 트랜잭션**이다 — 알림만 남고 결재가 되돌아가는 일이 없게.
   */
  async review(id: number, dto: ExecReviewDto, actorId: number): Promise<ExecReportWriteResultDto> {
    const reason = (dto.reason ?? '').trim();
    if (dto.action === 'rej' && reason === '') {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: '반려에는 사유가 필요합니다' });
    }
    await this.anyRepo.manager.transaction(async (em) => {
      const row = await this.row<{ id: string; sent_by: string | null; rpt_type: string; on_date: string }>(
        `UPDATE rpt
            SET state = $2::varchar, reviewed_at = now(), reviewed_by = $3,
                -- 같은 파라미터를 varchar 와 비교 두 곳에 쓰면 타입을 못 정한다 — 한 번만 캐스팅한다
                reject_reason = CASE WHEN $2::text = 'rej' THEN $4::text ELSE NULL END
          WHERE id = $1 AND state = 'sent'
            -- 올린 사람이 결재할 수 있는지는 lib/approval 의 목록이 정한다. 조각을 손으로 적으면
            -- 목록에서 이름을 빼도 여기만 계속 막아 단추와 서버가 어긋난다 (S5 · 실제로 한 번 그랬다).
            AND ${selfApprovalSqlGuard('rpt', 'sent_by', '$3')}
         RETURNING id, sent_by, rpt_type, to_char(on_date,'YYYY-MM-DD') AS on_date`,
        [id, dto.action, actorId, reason],
        em,
      );
      if (!row) {
        // 왜 안 됐는지는 한 번 더 읽어서 말한다 — 「올라온 보고만」과 「자기 보고」는 고치는 방법이 다르다
        const why = await this.row<{ state: string; sent_by: string | null }>(
          'SELECT state, sent_by FROM rpt WHERE id = $1', [id], em,
        );
        if (why && blocksSelfApproval('rpt', why.sent_by, actorId)) {
          throw new ConflictException({
            code: SELF_APPROVAL_CODE,
            message: '자기가 올린 보고는 자기가 결재할 수 없습니다 — 올리는 사람과 결재하는 사람은 다릅니다',
          });
        }
        throw new ConflictException({
          code: 'RPT_NOT_SENT',
          message: '올라온 보고만 결재할 수 있습니다',
        });
      }
      await this.log(actorId, id, dto.action, { state: dto.action, reason: dto.action === 'rej' ? reason : null }, em);
      // 본문은 사실만 — 무슨 보고 · 어느 기간 · (반려면) 대표가 적은 사유. 모양은 올리기 알림(「… 보고가 올라왔습니다 — 날짜」)과 같다
      const kind = labelOf(RPT_TYPE_LABEL, row.rpt_type);
      await em.query(
        `INSERT INTO noti (to_id, from_id, body, link, category, title)
         SELECT s.id, $2, $3, $4, 'request', $5 FROM staff s WHERE s.id = $1::bigint AND s.active AND s.id <> $2`,
        [
          row.sent_by, actorId,
          dto.action === 'rej'
            ? `${kind} 보고가 반려되었습니다 — ${row.on_date} · 사유: ${reason}`
            : `${kind} 보고가 승인되었습니다 — ${row.on_date}`,
          `/exec?view=${row.rpt_type}&date=${row.on_date}&rpt=${id}`,
          dto.action === 'rej' ? NOTI_TITLE.execRejected : NOTI_TITLE.execApproved,
        ],
      );
    });
    return this.writeResult(id);
  }

  /**
   * §73 「회수」 (W11 · N-97) — **올린 사람만** 올린 보고(sent)를 작성 중(draft)으로 되돌린다
   * (원문 슬라이드 73 「승인/반려는 대표만. 제출자는 회수(back)만 가능」).
   *
   * 메모는 그대로 둔다(다시 고쳐 올리려고 회수한다). 서명(올린 사람 · 시각)은 **지운다** — 올린 사실이 사라졌는데 서명이
   * 남으면 거짓이 되고, 짝 제약(`rpt_sign_pair`)과 다시 올리기(C85-a)의 규칙이 같다. 결재가 끝난 보고는 회수하지 않는다.
   * 행을 잠그고 읽어 기대 상태로 쓴다 — 그 사이 대표가 결재했으면 409 다. RPT · LOG 가 한 트랜잭션이다.
   */
  async withdraw(id: number, actorId: number): Promise<ExecReportWriteResultDto> {
    await this.anyRepo.manager.transaction(async (em) => {
      const cur = await this.row<{ state: string; sent_by: string | null; sent_at: string | null }>(
        `SELECT state, sent_by, ${kstAt('sent_at')} AS sent_at FROM rpt WHERE id = $1 FOR UPDATE`, [id], em,
      );
      if (!cur) throw new NotFoundException({ code: 'RPT_NOT_FOUND', message: '보고를 찾을 수 없습니다' });
      const blocked = rptWithdrawBlocked(cur.state, cur.sent_by, actorId);
      if (blocked?.code === 'RPT_NOT_SUBMITTER') throw new ForbiddenException(blocked);
      if (blocked) throw new ConflictException(blocked);
      await em.query(
        `UPDATE rpt SET state = 'draft', sent_at = NULL, sent_by = NULL WHERE id = $1 AND state = 'sent'`, [id],
      );
      await audit(em, 'report.withdraw', {
        actorId, entityId: id,
        before: { state: 'sent', sentBy: Number(cur.sent_by), sentAt: cur.sent_at },
        after: { state: 'draft', sentBy: null, sentAt: null },
      });
    });
    return this.writeResult(id);
  }

  /**
   * §69 영역 담당 지정 (W11 · N-81) — 영역마다 **고정 담당 한 명**(원문 슬라이드 72 표의 담당 열).
   * 대표 판정(`canCeoSetExecOwner`)이 컨트롤러에서 막는다. 처음엔 비어 있고 이름을 지어 넣지 않는다 — 대표가 화면에서 고른다.
   * `null` 이면 비운다(누가 언제 비웠는지는 행과 감사 줄에 남는다). 그만둔 사람은 고를 수 없다.
   */
  async setAreaOwner(key: ExecAreaKey, staffId: number | null, actorId: number): Promise<ExecAreaOwnerDto> {
    await this.anyRepo.manager.transaction(async (em) => {
      if (staffId !== null) {
        const [st] = (await em.query(`SELECT id FROM staff WHERE id = $1 AND active`, [staffId])) as R[];
        if (!st) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '활성 구성원을 찾을 수 없습니다' });
      }
      const [before] = (await em.query(
        `SELECT staff_id FROM exec_area_owner WHERE area_key = $1 FOR UPDATE`, [key],
      )) as Array<{ staff_id: string | null }>;
      await em.query(
        `INSERT INTO exec_area_owner (area_key, staff_id, set_by, set_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (area_key) DO UPDATE SET staff_id = EXCLUDED.staff_id, set_by = EXCLUDED.set_by, set_at = now()`,
        [key, staffId, actorId],
      );
      await audit(em, 'exec.area_owner', {
        // 영역은 글자 열쇠라 log.entity_id(bigint)에 차례(1부터 · 대표 관심순)를 적고 열쇠는 after 에 둔다
        actorId, entityId: EXEC_AREA_KEYS.indexOf(key) + 1,
        before: { areaKey: key, staffId: before?.staff_id == null ? null : Number(before.staff_id) },
        after: { areaKey: key, staffId },
      });
    });
    const owners = await this.areaOwners();
    return { key, ownerId: owners.get(key)?.id ?? null, ownerName: owners.get(key)?.name ?? null };
  }

  /** 영역 담당 — 지정한 적 없거나 비웠거나 그 사람이 지워졌으면(SET NULL) 없다 (이름을 지어내지 않는다) */
  private async areaOwners(): Promise<Map<string, { id: number; name: string }>> {
    const rows = await this.q(
      `SELECT o.area_key, s.id, s.name FROM exec_area_owner o JOIN staff s ON s.id = o.staff_id`,
    );
    return new Map(rows.map((r) => [String(r.area_key), { id: Number(r.id), name: String(r.name) }]));
  }

  /** append-only 이력 — 서명 두 칸이 못 담는 「누가 언제 무엇을」은 여기가 갖는다 */
  private async log(actorId: number, id: number, action: string, after: Record<string, unknown>, run: Runner = this.anyRepo): Promise<void> {
    await run.query(
      `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'rpt',$2,$3,$4::jsonb)`,
      [actorId, id, action, JSON.stringify(after)],
    );
  }

  /**
   * §73 결재함 — **이동만 한다** (N-12 · D-R27 · 원칙 22).
   * 줄마다 그 기간의 살펴볼 것을 다시 센다(D-R4 — 저장하지 않는다). 최근 것부터 12줄로 끊는다.
   */
  private async inbox(viewer?: ExecViewer): Promise<ExecInboxDto[]> {
    const rows = await this.q(
      `SELECT id, rpt_type, to_char(on_date,'YYYY-MM-DD') AS on_date, state, memo, reject_reason
         FROM rpt ORDER BY on_date DESC, id DESC LIMIT 12`,
    );
    const out: ExecInboxDto[] = [];
    for (const r of rows) {
      const rptType = String(r.rpt_type);
      const onDate = String(r.on_date);
      const span = ExecService.periodRange(rptType, onDate);
      const areas = await this.areaCounts(span.from, span.to, undefined, viewer, execAsOf(span.to, this.today()));
      out.push({
        id: Number(r.id), rptType, onDate,
        label: ExecService.periodLabel(rptType, onDate),
        state: String(r.state),
        apState: toApState(String(r.state)),
        filled: filledAreas(r.memo),
        reviewCount: areas.reduce((a, x) => a + x.count, 0),
        rejectReason: (r.reject_reason as string) ?? null,
        go: rptType,
      });
    }
    return out;
  }

  /**
   * 기간이 **달력 한 달 전체**인가 — §71 월간 판을 세울지 정하는 유일한 근거다.
   *
   * 주기 종류를 인자로 받지 않는다. 그것은 기간이 이미 말해 주는 사실이고(주는 달을 채울 수
   * 없고 하루도 그렇다), 입력이 둘이면 둘이 어긋날 수 있다.
   */
  private wholeMonth(from: string, to: string): boolean {
    return isWholeMonth(from, to);
  }

  /**
   * §71 월간 「어디서 놓쳤나」 — 이 달에 **들어온** 문의 중 지금 등록 실패인 것을
   * 중단 지점별로 센다. 조회는 한 번이다.
   *
   * 컷의 **「상담 퍼널」 판은 C90 이 세웠다** (N-45 · K-108) — 단계를 앞으로 옮기는 길(`PATCH /ops/leads/:id/stage`)이
   * 생겨 `LEAD_STAGE_LOG` 가 이름대로 도달을 기록한다. 그래서 **도달 기록으로** 센다: 이 달 들어온 건 중 그 단계의 기록이
   * 있거나 **지금 그 단계인** 건. 「보류·등록이면 2차를 거쳤겠지」는 여전히 세지 않는다(C86-b · 가정이다).
   * 옛 건은 기록이 없으므로(N-25 보정 0) `funnelSince` 로 **언제부터의 값인지** 화면이 말한다.
   */
  private async monthly(from: string, to: string): Promise<ExecMonthlyDto | null> {
    if (!this.wholeMonth(from, to)) return null;
    /*
     * 원본 §71 퍼널은 **네 줄**이다 — 「유입 → 1차 → 2차·진단 → 등록」(컷 · 슬라이드 글 · 71-5 · D-R44).
     * 「2차 · 진단」은 2차 상담에 **닿은** 건이다(`second`). 2차 대기는 줄로 세지 않는다 — 같은 컷의 「어디서 놓쳤나」가
     * 「2차 안 옴」을 따로 세므로, 기다리다 안 온 건을 2차에 닿았다고 세면 두 판이 서로 다른 말을 한다.
     */
    const funnelRows = await this.q(
      `SELECT count(*)::int AS inflow,
              count(*) FILTER (WHERE l.stage = 'first' OR EXISTS (SELECT 1 FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'first'))::int AS first,
              count(*) FILTER (WHERE l.stage = 'second' OR EXISTS (SELECT 1 FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'second'))::int AS second,
              count(*) FILTER (WHERE l.stage = 'enrolled' OR EXISTS (SELECT 1 FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'enrolled'))::int AS enrolled,
              (SELECT to_char(min(at) AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') FROM lead_stage_log WHERE stage = ANY($3)) AS since
         FROM lead l
        WHERE l.created_at::date BETWEEN $1::date AND $2::date`,
      [from, to, [...INTAKE_FUNNEL_STAGES]],
    );
    const f = funnelRows[0] ?? {};
    const inflow = Number(f.inflow ?? 0);
    const pct = (n: number) => (inflow === 0 ? 0 : Math.round((n / inflow) * 100));
    const funnel = [
      { key: 'inflow', label: '유입', count: inflow, pct: pct(inflow) },
      ...(['first', 'second', 'enrolled'] as const).map((key) => ({
        key, label: key === 'second' ? EXEC_FUNNEL_SECOND_LABEL : INTAKE_STAGE_LABEL[key],
        count: Number(f[key] ?? 0), pct: pct(Number(f[key] ?? 0)),
      })),
    ];
    const funnelSince = (f.since as string) ?? null;
    /*
     * 「어디서 놓쳤나」는 §24 와 **같은 넷 · 같은 낱말**이다(W11 · N-87 · §24 가 정본). 실패 당시 단계로 센다 —
     * fail_from 명시값 → 도달 기록 역순(failed 줄 제외) → 미분류. 옛 stop_at 은 읽지 않는다(읽기 전용 기록 · 대응표 이관 없음).
     */
    const rows = await this.q(
      `SELECT CASE WHEN l.stage = 'failed' THEN COALESCE(l.fail_from, ${leadLogLastStageSql('l.id')}) END AS fail_stage,
              count(*)::int AS n,
              count(*) FILTER (WHERE l.stage = 'failed')::int AS lost
         FROM lead l
        WHERE l.created_at::date BETWEEN $1::date AND $2::date
        GROUP BY 1`,
      [from, to],
    );
    const lostBy = new Map<string, { label: string; count: number }>();
    let leads = 0;
    for (const r of rows) {
      leads += Number(r.n);
      const lost = Number(r.lost);
      if (lost <= 0) continue;
      const stop = intakeFailStop((r.fail_stage as string | null) ?? null);
      const cur = lostBy.get(stop.key);
      lostBy.set(stop.key, { label: stop.label, count: (cur?.count ?? 0) + lost });
    }
    const order: string[] = [...INTAKE_FAIL_STOPS, INTAKE_FAIL_STOP_UNSET];
    const lostRows = order
      .filter((key) => (lostBy.get(key)?.count ?? 0) > 0)
      .map((key) => ({
        key,
        label: lostBy.get(key)!.label,
        count: lostBy.get(key)!.count,
      }));
    return { leads, lost: lostRows.reduce((a, r) => a + r.count, 0), lostRows, funnel, funnelSince };
  }

  async range(from: string, to: string, canSeeAmounts: boolean, viewer?: ExecViewer): Promise<ExecDto> {
    // 기간에 드는 회차는 **실제 수업일**로 센다 — 현황판 · 캘린더 · 리포트 목록과 같은 집합이다. 옮긴 회차는 옮긴 날에 든다 (MEETING-MOVE)
    const DRAWN = drawnDateOf('o');
    const [lessons, canceled, students, newLeads, enrolled, unwritten] = await Promise.all([
      this.one(`SELECT count(*)::text n FROM ser_occ o
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE ${DRAWN} BETWEEN $1::date AND $2::date AND NOT o.canceled
                  AND COALESCE(a.result,'completed') <> 'canceled'`, [from, to]),
      this.one(`SELECT count(*)::text n FROM ser_occ o
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE ${DRAWN} BETWEEN $1::date AND $2::date
                  AND (o.canceled OR a.result='canceled')`, [from, to]),
      this.one(`SELECT count(DISTINCT ss.student_id)::text n FROM ser_occ o
                 JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE ${DRAWN} BETWEEN $1::date AND $2::date AND NOT o.canceled
                  AND COALESCE(a.result,'completed') <> 'canceled'`, [from, to]),
      // 주간의 지난주 값(weekPrev)이 같은 문장을 −7일에 부른다 — §70 「같은 방식으로」
      this.one(LEADS_IN_SQL, [from, to]),
      // 「등록」은 상담이 들어온 날이 아니라 수강이 **시작된** 날로 센다.
      // lead.created_at 으로 세면 작년에 상담한 학생이 이번 달 등록으로 잡히지 않는다.
      this.one(`SELECT count(*)::text n FROM enr WHERE started_on BETWEEN $1::date AND $2::date`, [from, to]),
      // §47 독촉 화면과 **같은 정의**를 쓴다 — 지난 수업인데 안 쓴 것.
      // 여기만 다르게 세면 대표 보고와 독촉 화면의 숫자가 어긋나고, 어느 쪽이 맞는지 아무도 모른다.
      this.one(
        `SELECT count(*)::text n FROM rep r
           JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
           JOIN ser s ON s.id = r.ser_id
           JOIN kind k ON k.key = COALESCE(r.kind_key, s.kind_key)
           LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
          WHERE r.state = ANY($3::rep_state_t[]) AND upper(o.span) < now()
            AND k.rep AND NOT o.canceled AND COALESCE(a.result,'completed') <> 'canceled'
            AND ${DRAWN} BETWEEN $1::date AND $2::date`,
        [from, to, REPORT_UNWRITTEN_CANDIDATE_DB],
      ),
    ]);

    // 금액 — 권한이 없으면 아예 세지 않는다. 세어 두고 지우면 실수로 흘린다.
    // 수입은 REVENUE_SQL 한 문장이다 — 머리 「들어온 돈」과 회계 카드 「입금」 타일이 같이 읽는다
    const [rev] = await this.q(REVENUE_SQL, [from, to, canSeeAmounts]);
    const revenueFacts = { total: rev?.total === null || rev?.total === undefined ? null : Number(rev.total), n: Number(rev?.n ?? 0) };
    const revenue: number | null = canSeeAmounts ? revenueFacts.total : null;
    let expense: number | null = null;
    let payout: number | null = null;
    if (canSeeAmounts) {
      // 확정된 지출만 센다 — 아직 결재 중인 건(requested_amount)은 나간 돈이 아니다.
      expense = await this.one(
        `SELECT COALESCE(sum(amount),0)::text n FROM expense
          WHERE state = 'approved' AND spend_on BETWEEN $1::date AND $2::date`, [from, to]);
      /**
       * **강사료** — 원본 §71 컷과 테스트 시나리오 H-86 이 같은 식을 적는다:
       * 「매출(입금) − **강사료** − 지출 = 이익」. 이 칸이 없어 **이익이 인건비만큼 부풀어** 있었다.
       *
       * 세는 것은 **확정된 정산의 과세표준**(`gross − 지각 차감`)이다 — 지출과 같은 규약으로
       * **확정된 것만** 세고(작성 중인 정산은 나간 돈이 아니다 · `confirmed_by`), 원천징수는 빼지 않는다:
       * 떼어 둔 세금도 학원이 내보내는 돈이라 강사에게 간 `net` 만 빼면 그만큼 이익이 또 부풀어 오른다
       * (`lib/payout-sheet` 가 이 값을 「과세표준」이라 부른다).
       *
       * 달이 아니라 **기간**으로 묻는 화면이라, 그 기간에 **온전히 들어오는 달**의 정산만 센다 —
       * 8월 정산을 8/1~8/15 에 절반만 얹을 방법이 없고, 나눠 적으면 없는 정밀도를 지어내는 것이다.
       */
      payout = await this.one(
        `SELECT COALESCE(sum(gross - late_rep_cut - late_cls_cut),0)::text n
           FROM payout
          WHERE confirmed_by IS NOT NULL
            AND to_date(year_month,'YYYY-MM') >= date_trunc('month', $1::date)
            AND (to_date(year_month,'YYYY-MM') + interval '1 month - 1 day')::date <= $2::date`,
        [from, to],
      );
    }

    const stats: ExecStatDto[] = [
      { key: 'lessons',  label: '진행한 수업',   value: lessons,  unit: '회', money: false },
      { key: 'canceled', label: '취소·휴강',     value: canceled, unit: '회', money: false },
      { key: 'students', label: '수업받은 학생', value: students, unit: '명', money: false },
      // 원문 §70 의 낱말은 「신규 **문의**」다 (70-3) — 상담은 그 뒤의 단계다
      { key: 'leads',    label: '신규 문의',     value: newLeads, unit: '건', money: false },
      { key: 'enrolled', label: '등록',          value: enrolled, unit: '건', money: false },
      { key: 'unwritten',label: '안 쓴 리포트',  value: unwritten,unit: '건', money: false },
      // 원문 §71 의 낱말은 「매출 (입금)」이다 (71-2) — 청구가 아니라 들어온 돈이라는 말까지 붙어 있다
      { key: 'revenue',  label: '매출 (입금)',   value: revenue,  unit: '원', money: true },
      { key: 'payout',   label: '강사료',        value: payout,   unit: '원', money: true },
      { key: 'expense',  label: '지출',          value: expense,  unit: '원', money: true },
      { key: 'profit',   label: '이익',
        value: revenue !== null && expense !== null && payout !== null
          ? revenue - payout - expense : null,
        unit: '원', money: true },
      /**
       * 이익률 — 원본 §71 이 이익 옆에 「−268%」를 적는다. 나누는 것은 **수입**이고,
       * 수입이 0 이면 비율이 없다(0% 라 적으면 「본전」으로 읽힌다).
       */
      { key: 'margin',   label: '이익률',
        value: revenue !== null && expense !== null && payout !== null && revenue > 0
          ? Math.round(((revenue - payout - expense) / revenue) * 100) : null,
        unit: '%', money: true },
    ];

    const reports = (await this.q(
      `SELECT r.id, r.rpt_type, to_char(r.on_date,'YYYY-MM-DD') AS on_date, r.state,
              r.memo AS memo_json,
              ${kstAt(`r.sent_at`)}     AS sent_at,
              ${kstAt(`r.reviewed_at`)} AS reviewed_at,
              r.reject_reason, r.sent_by,
              sb.name AS sent_by_name, rb.name AS reviewed_by_name
         FROM rpt r
         LEFT JOIN staff sb ON sb.id = r.sent_by
         LEFT JOIN staff rb ON rb.id = r.reviewed_by
        WHERE r.on_date BETWEEN $1::date AND $2::date
        ORDER BY r.on_date DESC, r.id DESC`,
      [from, to],
    )).map((r) => ({
      id: Number(r.id), rptType: String(r.rpt_type), onDate: String(r.on_date),
      state: String(r.state),
      // 옛 한 줄 칸(`memo` — jsonb 를 글자로 내리면 6영역 메모가 JSON 글자가 됐다)은 W11 에서 뺐다 — 화면은 이것만 읽는다 (7-3 ②)
      // 여섯 칸은 **언제나 다 내려간다** — 화면이 칸을 만들면 순서와 낱말이 갈린다 (D-R18 · D-R25)
      memos: areaMemos(r.memo_json),
      filled: filledAreas(r.memo_json),
      sentAt: (r.sent_at as string) ?? null,
      reviewedAt: (r.reviewed_at as string) ?? null,
      rejectReason: (r.reject_reason as string) ?? null,
      sentByName: (r.sent_by_name as string) ?? null,
      reviewedByName: (r.reviewed_by_name as string) ?? null,
      /* 단추 판정은 여기 한 곳이다 — 보는 사람을 모르면 닫는다 (모르는 쪽으로 열면 눌렀을 때 거절당한다) */
      canReview: String(r.state) === 'sent' && canSeeAmounts
        && viewer !== undefined && viewer.canApprove
        && !blocksSelfApproval('rpt', r.sent_by, viewer.id),
      /*
       * 「작성 중 저장」·「대표께 올리기」도 여기서 정한다 (S5 · D-R39).
       *
       * 화면은 `canCrudAll` 이라는 **역할 권한**만 보고 있어서, 이미 올린 보고(`sent`)나 결재가 끝난
       * 보고(`ok`)에서도 두 단추가 선 채 눌러야만 409 `RPT_LOCKED` 를 받았다. 쓰기가 보는 집합은
       * `('draft','rej')` 하나다 — 그것을 그대로 내려보낸다. 문장도 쓰기가 내는 말과 같다.
       */
      canWriteMemo: WRITABLE_RPT_STATES.includes(String(r.state)),
      writeBlockedReason: WRITABLE_RPT_STATES.includes(String(r.state)) ? null : rptLockedMessage(String(r.state)),
      // 「회수」 — 올린 사람 본인 · 올라간 보고만(쓰기와 같은 판정 · N-97). 보는 사람을 모르면 닫는다
      canWithdraw: viewer !== undefined && rptWithdrawBlocked(String(r.state), r.sent_by, viewer.id) === null,
    }));

    // 현황판은 **한 번만** 부른다 — 수업 배지 · 수업 타일 · 주간 「수업 준비 x/y」가 같은 판정을 읽는다
    const board = await this.board.range({ from, to });
    // 「지금 남아 있는 것」의 기준일 — 기간 끝과 오늘 중 앞선 날(H-79). 기간에 일어난 것(입금 · 접수 …)은 그대로 from~to
    const asOf = execAsOf(to, this.today());
    const counts = await this.areaCounts(from, to, board, viewer, asOf);
    const kind = execPeriodKind(from, to);
    const facts = await this.areaFacts(from, to, canSeeAmounts, board, revenueFacts, viewer, asOf);
    const details = execAreaDetails(kind, facts);
    const items = await this.areaItems(from, to, canSeeAmounts, board, viewer, asOf);
    const owners = await this.areaOwners();
    const areas = counts.map((a) => ({
      ...a, headline: details[a.key].headline, tiles: details[a.key].tiles,
      itemsLabel: execAreaItemsLabel(a.key, kind, items[a.key].length), items: items[a.key],
      // 영역 담당(N-81) — 처음엔 비어 있다. 바꾸는 단추는 대표 판정 한 곳(canSetOwner)
      ownerId: owners.get(a.key)?.id ?? null,
      ownerName: owners.get(a.key)?.name ?? null,
      canSetOwner: viewer?.canSetOwner === true,
    }));
    const inbox = await this.inbox(viewer);
    // 이 기간의 보고가 있으면 그 기재 수를, 없으면 0 — 「담당 x/6 기재」 (§69 머리)
    const here = inbox.find((r) => r.onDate >= from && r.onDate <= to);

    return {
      from, to,
      periodKind: kind,
      sheetTitle: EXEC_SHEET_TITLE[kind],
      periodLabel: execPeriodLabel(kind, from, to),
      head: ExecService.head(kind, facts, board, stats, kind === 'week' ? await this.weekPrev(from, to, canSeeAmounts) : null),
      stats, reports,
      areas,
      reviewCount: areas.reduce((a, x) => a + x.count, 0),
      filled: here?.filled ?? 0,
      inbox,
      monthly: await this.monthly(from, to),
      canSeeAmounts, computedAt: new Date().toISOString(),
    };
  }
}
