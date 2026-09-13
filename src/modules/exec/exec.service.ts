/** @file-guide
 * 목적: exec.service.ts — ExecService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { REPORT_UNWRITTEN_CANDIDATE_DB } from '../../lib/rules';
import { EXEC_AREAS, filledAreas } from '../../lib/exec-areas';
import { toApState } from '../../lib/approval';
import { BoardService } from '../board/board.service';
import type { ExecAreaDto, ExecDto, ExecInboxDto, ExecStatDto } from './exec.dto';
import { kstAt } from '../../lib/sql';

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
                 JOIN ser_stu ss ON ss.ser_id = o.ser_id
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
    if (canSeeAmounts) {
      revenue = await this.one(
        `SELECT COALESCE(sum(amount),0)::text n FROM pay WHERE paid_on BETWEEN $1::date AND $2::date`, [from, to]);
      // 확정된 지출만 센다 — 아직 결재 중인 건(requested_amount)은 나간 돈이 아니다.
      expense = await this.one(
        `SELECT COALESCE(sum(amount),0)::text n FROM expense
          WHERE state = 'approved' AND spend_on BETWEEN $1::date AND $2::date`, [from, to]);
    }

    const stats: ExecStatDto[] = [
      { key: 'lessons',  label: '진행한 수업',   value: lessons,  unit: '회', money: false },
      { key: 'canceled', label: '취소·휴강',     value: canceled, unit: '회', money: false },
      { key: 'students', label: '수업받은 학생', value: students, unit: '명', money: false },
      { key: 'leads',    label: '신규 상담',     value: newLeads, unit: '건', money: false },
      { key: 'enrolled', label: '등록',          value: enrolled, unit: '건', money: false },
      { key: 'unwritten',label: '안 쓴 리포트',  value: unwritten,unit: '건', money: false },
      { key: 'revenue',  label: '수입',          value: revenue,  unit: '원', money: true },
      { key: 'expense',  label: '지출',          value: expense,  unit: '원', money: true },
      { key: 'profit',   label: '이익',
        value: revenue !== null && expense !== null ? revenue - expense : null, unit: '원', money: true },
    ];

    const reports = (await this.q(
      `SELECT id, rpt_type, to_char(on_date,'YYYY-MM-DD') AS on_date, state,
              -- memo 는 jsonb 다. 그대로 내려보내면 화면에 [object Object] 가 찍힌다.
              COALESCE(memo->>'note', memo::text) AS memo,
              ${kstAt(`sent_at`)}     AS sent_at,
              ${kstAt(`reviewed_at`)} AS reviewed_at,
              reject_reason
         FROM rpt WHERE on_date BETWEEN $1::date AND $2::date
        ORDER BY on_date DESC, id DESC`,
      [from, to],
    )).map((r) => ({
      id: Number(r.id), rptType: String(r.rpt_type), onDate: String(r.on_date),
      state: String(r.state), memo: String(r.memo ?? ''),
      sentAt: (r.sent_at as string) ?? null,
      reviewedAt: (r.reviewed_at as string) ?? null,
      rejectReason: (r.reject_reason as string) ?? null,
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
      canSeeAmounts, computedAt: new Date().toISOString(),
    };
  }
}
