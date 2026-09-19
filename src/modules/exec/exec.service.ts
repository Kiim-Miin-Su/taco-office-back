/** @file-guide
 * 목적: exec.service.ts — ExecService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { REPORT_UNWRITTEN_CANDIDATE_DB } from '../../lib/rules';
import { EXEC_AREA_KEYS, EXEC_AREAS, filledAreas } from '../../lib/exec-areas';
import { INTAKE_FUNNEL_STAGES, INTAKE_STAGE_LABEL, INTAKE_STOPS, INTAKE_STOP_UNSET, intakeStopLabel } from '../../lib/intake-words';
import { labelOf, RPT_TYPE_LABEL, toApState } from '../../lib/approval';
import { BoardService } from '../board/board.service';
import type {
  ExecAreaDto, ExecAreaMemoDto, ExecDto, ExecInboxDto, ExecMemoWriteDto, ExecMonthlyDto,
  ExecReportWriteResultDto, ExecReviewDto, ExecStatDto, ExecSubmitDto,
} from './exec.dto';

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
import { kstAt, serStuOn } from '../../lib/sql';

type R = Record<string, unknown>;

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
  private async row<T = R>(sql: string, p: unknown[] = []): Promise<T | null> {
    const out = (await this.anyRepo.query(sql, p)) as unknown;
    const rows = Array.isArray(out) && Array.isArray(out[0]) ? (out[0] as T[]) : (out as T[]);
    return rows.length ? rows[0] : null;
  }


  /**
   * §69 6영역 — 살펴볼 것을 센다. 정의는 `lib/exec-areas.ts` 한 곳에 있다.
   * 수업만 현황판(`clChk()`)의 판정을 그대로 가져온다.
   */
  private async areaCounts(from: string, to: string): Promise<ExecAreaDto[]> {
    const out: ExecAreaDto[] = [];
    for (const a of EXEC_AREAS) {
      let count = 0;
      if (a.key === 'lesson') {
        count = (await this.board.range({ from, to })).missingCount;
      } else if (a.sql) {
        // 기준일을 안 쓰는 판정(안 끝난 컴플레인 등)에 인자를 넘기면 bind 오류가 난다
        count = await this.one(a.sql, a.sql.includes('$1') ? [to] : []);
      }
      out.push({ key: a.key, label: a.label, review: a.review, count, go: a.go });
    }
    return out;
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
    const d = Number(onDate.slice(8));
    const dow = '일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${String(y).slice(2)}년 ${m}월 ${d}일 ${dow}요일`;
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
        WHERE rpt.state IN ('draft', 'rej')
       RETURNING id, state`,
      [dto.rptType, key, JSON.stringify(patch)],
    );
    if (!row) {
      throw new ConflictException({
        code: 'RPT_LOCKED',
        message: '이미 올린 보고는 고칠 수 없습니다. 반려된 뒤에 다시 적어 주세요',
      });
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
    if (!['draft', 'rej'].includes(String(found.state))) {
      throw new ConflictException({ code: 'RPT_LOCKED', message: '이미 올린 보고입니다' });
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
      `INSERT INTO noti (to_id, from_id, body, link, category)
       SELECT id, $1, $2, $3, 'request' FROM staff WHERE active AND role = 'ceo' AND id <> $1`,
      [
        actorId,
        `${labelOf(RPT_TYPE_LABEL, dto.rptType)} 보고가 올라왔습니다 — ${key}`,
        `/exec?view=${dto.rptType}&date=${key}&rpt=${Number(found.id)}`,
      ],
    );
    return this.writeResult(Number(found.id));
  }

  /**
   * §73 결재 — **대표만** 한다 (`lib/approval` 의 `APPROVAL_FLOW_RECIPIENT.rpt = 'ceo'`).
   * 반려는 사유가 반드시 있다 (D-R13) — 왜 돌아왔는지 모르면 다시 올릴 수가 없다.
   */
  async review(id: number, dto: ExecReviewDto, actorId: number): Promise<ExecReportWriteResultDto> {
    const reason = (dto.reason ?? '').trim();
    if (dto.action === 'rej' && reason === '') {
      throw new BadRequestException({ code: 'REASON_REQUIRED', message: '반려에는 사유가 필요합니다 (D-R13)' });
    }
    const row = await this.row(
      `UPDATE rpt
          SET state = $2::varchar, reviewed_at = now(), reviewed_by = $3,
              -- 같은 파라미터를 varchar 와 비교 두 곳에 쓰면 타입을 못 정한다 — 한 번만 캐스팅한다
              reject_reason = CASE WHEN $2::text = 'rej' THEN $4::text ELSE NULL END
        WHERE id = $1 AND state = 'sent'
       RETURNING id`,
      [id, dto.action, actorId, reason],
    );
    if (!row) {
      throw new ConflictException({
        code: 'RPT_NOT_SENT',
        message: '올라온 보고만 결재할 수 있습니다',
      });
    }
    await this.log(actorId, id, dto.action, { state: dto.action, reason: dto.action === 'rej' ? reason : null });
    return this.writeResult(id);
  }

  /** append-only 이력 — 서명 두 칸이 못 담는 「누가 언제 무엇을」은 여기가 갖는다 */
  private async log(actorId: number, id: number, action: string, after: Record<string, unknown>): Promise<void> {
    await this.q(
      `INSERT INTO log (actor_id, entity, entity_id, action, after) VALUES ($1,'rpt',$2,$3,$4::jsonb)`,
      [actorId, id, action, JSON.stringify(after)],
    );
  }

  /**
   * §73 결재함 — **이동만 한다** (N-12 · D-R27 · 원칙 22).
   * 줄마다 그 기간의 살펴볼 것을 다시 센다(D-R4 — 저장하지 않는다). 최근 것부터 12줄로 끊는다.
   */
  private async inbox(): Promise<ExecInboxDto[]> {
    const rows = await this.q(
      `SELECT id, rpt_type, to_char(on_date,'YYYY-MM-DD') AS on_date, state, memo, reject_reason
         FROM rpt ORDER BY on_date DESC, id DESC LIMIT 12`,
    );
    const out: ExecInboxDto[] = [];
    for (const r of rows) {
      const rptType = String(r.rpt_type);
      const onDate = String(r.on_date);
      const span = ExecService.periodRange(rptType, onDate);
      const areas = await this.areaCounts(span.from, span.to);
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
    if (!from.endsWith('-01')) return false;
    const [y, m] = from.split('-').map(Number);
    // 다음 달 0일 = 이 달의 마지막 날. UTC 로 만들어 표준시 경계에서 하루가 밀리지 않게 한다.
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return to === last;
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
    const funnelRows = await this.q(
      `SELECT count(*)::int AS inflow,
              count(*) FILTER (WHERE l.stage = 'first' OR EXISTS (SELECT 1 FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'first'))::int AS first,
              count(*) FILTER (WHERE l.stage = 'wait2nd' OR EXISTS (SELECT 1 FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'wait2nd'))::int AS wait2nd,
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
      ...(['first', 'wait2nd', 'second', 'enrolled'] as const).map((key) => ({
        key, label: INTAKE_STAGE_LABEL[key], count: Number(f[key] ?? 0), pct: pct(Number(f[key] ?? 0)),
      })),
    ];
    const funnelSince = (f.since as string) ?? null;
    const rows = await this.q(
      `SELECT COALESCE(stop_at, $3) AS key, count(*)::int AS n,
              count(*) FILTER (WHERE stage = 'failed')::int AS lost
         FROM lead
        WHERE created_at::date BETWEEN $1::date AND $2::date
        GROUP BY 1`,
      [from, to, INTAKE_STOP_UNSET],
    );
    // 실패가 아닌 건에도 stop_at 이 남아 있을 수 있다(되살린 건) — 실패인 것만 줄로 센다.
    const lostBy = new Map<string, number>();
    let leads = 0;
    for (const r of rows) {
      leads += Number(r.n);
      const lost = Number(r.lost);
      if (lost > 0) lostBy.set(String(r.key), (lostBy.get(String(r.key)) ?? 0) + lost);
    }
    const order = [...INTAKE_STOPS, INTAKE_STOP_UNSET];
    const lostRows = order
      .filter((key) => (lostBy.get(key) ?? 0) > 0)
      .map((key) => ({
        key,
        label: intakeStopLabel(key),
        count: lostBy.get(key) ?? 0,
      }));
    return { leads, lost: lostRows.reduce((a, r) => a + r.count, 0), lostRows, funnel, funnelSince };
  }

  async range(from: string, to: string, canSeeAmounts: boolean): Promise<ExecDto> {
    const [lessons, canceled, students, newLeads, enrolled, unwritten] = await Promise.all([
      this.one(`SELECT count(*)::text n FROM ser_occ o
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE o.on_date BETWEEN $1::date AND $2::date AND NOT o.canceled
                  AND COALESCE(a.result,'completed') <> 'canceled'`, [from, to]),
      this.one(`SELECT count(*)::text n FROM ser_occ o
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE o.on_date BETWEEN $1::date AND $2::date
                  AND (o.canceled OR a.result='canceled')`, [from, to]),
      this.one(`SELECT count(DISTINCT ss.student_id)::text n FROM ser_occ o
                 JOIN ser_stu ss ON ss.ser_id = o.ser_id AND ${serStuOn('ss', 'o.on_date')}
                 LEFT JOIN att a ON a.ser_id=o.ser_id AND a.on_date=o.on_date
                WHERE o.on_date BETWEEN $1::date AND $2::date AND NOT o.canceled
                  AND COALESCE(a.result,'completed') <> 'canceled'`, [from, to]),
      this.one(`SELECT count(*)::text n FROM lead WHERE created_at::date BETWEEN $1::date AND $2::date`, [from, to]),
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
            AND r.on_date BETWEEN $1::date AND $2::date`,
        [from, to, REPORT_UNWRITTEN_CANDIDATE_DB],
      ),
    ]);

    // 금액 — 권한이 없으면 아예 세지 않는다. 세어 두고 지우면 실수로 흘린다.
    let revenue: number | null = null;
    let expense: number | null = null;
    let payout: number | null = null;
    if (canSeeAmounts) {
      revenue = await this.one(
        `SELECT COALESCE(sum(amount),0)::text n FROM pay WHERE paid_on BETWEEN $1::date AND $2::date`, [from, to]);
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
      { key: 'leads',    label: '신규 상담',     value: newLeads, unit: '건', money: false },
      { key: 'enrolled', label: '등록',          value: enrolled, unit: '건', money: false },
      { key: 'unwritten',label: '안 쓴 리포트',  value: unwritten,unit: '건', money: false },
      { key: 'revenue',  label: '수입',          value: revenue,  unit: '원', money: true },
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
              -- memo 는 jsonb 다. 그대로 내려보내면 화면에 [object Object] 가 찍힌다.
              COALESCE(r.memo->>'note', r.memo::text) AS memo,
              r.memo AS memo_json,
              ${kstAt(`r.sent_at`)}     AS sent_at,
              ${kstAt(`r.reviewed_at`)} AS reviewed_at,
              r.reject_reason,
              sb.name AS sent_by_name, rb.name AS reviewed_by_name
         FROM rpt r
         LEFT JOIN staff sb ON sb.id = r.sent_by
         LEFT JOIN staff rb ON rb.id = r.reviewed_by
        WHERE r.on_date BETWEEN $1::date AND $2::date
        ORDER BY r.on_date DESC, r.id DESC`,
      [from, to],
    )).map((r) => ({
      id: Number(r.id), rptType: String(r.rpt_type), onDate: String(r.on_date),
      state: String(r.state), memo: String(r.memo ?? ''),
      // 여섯 칸은 **언제나 다 내려간다** — 화면이 칸을 만들면 순서와 낱말이 갈린다 (D-R18 · D-R25)
      memos: areaMemos(r.memo_json),
      filled: filledAreas(r.memo_json),
      sentAt: (r.sent_at as string) ?? null,
      reviewedAt: (r.reviewed_at as string) ?? null,
      rejectReason: (r.reject_reason as string) ?? null,
      sentByName: (r.sent_by_name as string) ?? null,
      reviewedByName: (r.reviewed_by_name as string) ?? null,
    }));

    const areas = await this.areaCounts(from, to);
    const inbox = await this.inbox();
    // 이 기간의 보고가 있으면 그 기재 수를, 없으면 0 — 「담당 x/6 기재」 (§69 머리)
    const here = inbox.find((r) => r.onDate >= from && r.onDate <= to);

    return {
      from, to, stats, reports,
      areas,
      reviewCount: areas.reduce((a, x) => a + x.count, 0),
      filled: here?.filled ?? 0,
      inbox,
      monthly: await this.monthly(from, to),
      canSeeAmounts, computedAt: new Date().toISOString(),
    };
  }
}
