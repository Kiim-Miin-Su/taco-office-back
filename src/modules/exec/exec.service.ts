import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { REPORT_PENDING_DB } from '../../lib/rules';
import type { ExecDto, ExecStatDto } from './exec.dto';

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
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private async one(sql: string, p: unknown[] = []): Promise<number> {
    const r = (await this.anyRepo.query(sql, p)) as Array<{ n: string }>;
    return Number(r[0]?.n ?? 0);
  }

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  async range(from: string, to: string, canSeeAmounts: boolean): Promise<ExecDto> {
    const [lessons, canceled, students, newLeads, enrolled, unwritten] = await Promise.all([
      this.one(`SELECT count(*)::text n FROM ser_occ WHERE on_date BETWEEN $1::date AND $2::date AND NOT canceled`, [from, to]),
      this.one(`SELECT count(*)::text n FROM ser_occ WHERE on_date BETWEEN $1::date AND $2::date AND canceled`, [from, to]),
      this.one(`SELECT count(DISTINCT ss.student_id)::text n FROM ser_occ o JOIN ser_stu ss ON ss.ser_id = o.ser_id
                 WHERE o.on_date BETWEEN $1::date AND $2::date AND NOT o.canceled`, [from, to]),
      this.one(`SELECT count(*)::text n FROM lead WHERE created_at::date BETWEEN $1::date AND $2::date`, [from, to]),
      // 「등록」은 상담이 들어온 날이 아니라 수강이 **시작된** 날로 센다.
      // lead.created_at 으로 세면 작년에 상담한 학생이 이번 달 등록으로 잡히지 않는다.
      this.one(`SELECT count(*)::text n FROM enr WHERE started_on BETWEEN $1::date AND $2::date`, [from, to]),
      // §47 독촉 화면과 **같은 정의**를 쓴다 — 지난 수업인데 안 쓴 것.
      // 여기만 다르게 세면 대표 보고와 독촉 화면의 숫자가 어긋나고, 어느 쪽이 맞는지 아무도 모른다.
      this.one(
        `SELECT count(*)::text n FROM rep r
           JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
          WHERE r.state = ANY($3) AND upper(o.span) < now()
            AND r.on_date BETWEEN $1::date AND $2::date`,
        [from, to, REPORT_PENDING_DB],
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
          WHERE state = 'confirmed' AND spend_on BETWEEN $1::date AND $2::date`, [from, to]);
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
              to_char(sent_at,'YYYY-MM-DD"T"HH24:MI:SSOF')     AS sent_at,
              to_char(reviewed_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS reviewed_at,
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

    return { from, to, stats, reports, canSeeAmounts, computedAt: new Date().toISOString() };
  }
}
