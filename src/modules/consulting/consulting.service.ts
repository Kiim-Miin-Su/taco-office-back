import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { csCan, csCanAmount, csCanFull, type ConsShare, type ConsViewer } from '../../lib/rules';
import type { ConsultingListDto, ConsultingSessionDto } from './consulting.dto';
import { consultingRecordIssue, consultingSessionIssue, type ConsultingRecord } from './consulting.rules';

type R = Record<string, unknown>;

function assertRecord(record: { stage: unknown; contractStep: unknown; sessions: unknown }): asserts record is ConsultingRecord {
  if (consultingRecordIssue(record)) throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
}

/**
 * 컨설팅 — 권한이 **두 층**이다 (DEV-SPEC §4.4).
 *
 *   ① 역할 파생 (D-R39)      — 탭을 열 수 있는가 · 금액을 볼 수 있는가
 *   ② 건별 공개 범위 (share) — 이 건이 목록에 보이는가 · 내용이 열리는가
 *
 * 둘은 독립이라 **둘 다** 통과해야 보인다. 판정은 rules.ts 의 csCan/csCanFull/csCanAmount
 * 한 곳에서만 하고, 여기서는 그 결과로 행을 거를 뿐이다.
 */
@Injectable()
export class ConsultingService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string, p: unknown[] = []): Promise<T[]> {
    return this.anyRepo.query(sql, p) as Promise<T[]>;
  }

  async all(viewerId: number, canMoney: boolean, canHide: boolean): Promise<ConsultingListDto> {
    const rows = await this.q(
      `SELECT c.id, c.cons_type, c.stage, c.contract_step, c.amount, c.sessions, c.share, c.owner_id,
              to_char(c.end_on,'YYYY-MM-DD')      AS end_on,
              to_char(c.created_at,'YYYY-MM-DD')  AS created_at,
              o.name AS owner_name,
              EXISTS (SELECT 1 FROM cons_pick p WHERE p.cons_id = c.id AND p.staff_id = $1) AS is_picked,
              COALESCE(
                (SELECT array_agg(s.name ORDER BY s.name)
                   FROM cons_stu cs JOIN stu s ON s.id = cs.student_id
                  WHERE cs.cons_id = c.id), '{}') AS student_names
         FROM cons c LEFT JOIN staff o ON o.id = c.owner_id
        ORDER BY c.created_at DESC, c.id`,
      [viewerId],
    );

    // 권한 판정은 csCan* 한 곳만 사용한다. 숨겨진 건의 오염/회차도 응답에 영향을 주지 않는다.
    const visible = rows.flatMap((r) => {
      const share = String(r.share) as ConsShare;
      const viewer: ConsViewer = {
        isOwner: r.owner_id !== null && Number(r.owner_id) === viewerId,
        isPicked: r.is_picked === true, canHide, canMoney,
      };
      return csCan(share, viewer) ? [{ r, share, full: csCanFull(share, viewer), money: csCanAmount(share, viewer) }] : [];
    });
    const fullIds = visible.filter(({ full }) => full).map(({ r }) => Number(r.id));
    const logs = fullIds.length ? await this.q(
      `SELECT id, cons_id, seq, to_char(on_date,'YYYY-MM-DD') AS on_date, who, what, why, how, ser_id
         FROM cons_sess WHERE cons_id = ANY($1::bigint[]) ORDER BY cons_id, seq`,
      [fullIds],
    ) : [];
    const byCons = new Map<number, ConsultingSessionDto[]>();
    for (const r of logs) {
      const k = Number(r.cons_id);
      if (!byCons.has(k)) byCons.set(k, []);
      byCons.get(k)!.push({
        id: Number(r.id), seq: Number(r.seq), onDate: (r.on_date as string) ?? null,
        who: (r.who as string) ?? null, what: (r.what as string) ?? null,
        why: (r.why as string) ?? null, how: (r.how as string) ?? null,
        serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
      });
    }

    for (const sessions of byCons.values()) {
      if (consultingSessionIssue(sessions.map(({ seq }) => seq))) {
        throw new InternalServerErrorException('컨설팅 데이터 무결성 오류');
      }
    }

    const items = visible.map(({ r, share, full, money }) => {
      const record = { stage: r.stage, contractStep: r.contract_step, sessions: r.sessions };
      assertRecord(record);

      return {
        id: Number(r.id),
        consType: String(r.cons_type),
        stage: record.stage,
        share,
        contractStep: record.contractStep,
        studentNames: (r.student_names as string[]) ?? [],
        ownerName: (r.owner_name as string) ?? null,
        sessions: record.sessions,
        endOn: (r.end_on as string) ?? null,
        createdAt: String(r.created_at),
        amount: money && r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
        canOpen: full,
        // 내용이 안 열리면 회차 기록도 내려보내지 않는다 — 화면에서 감추는 건 감춘 게 아니다
        sessionsLog: full ? (byCons.get(Number(r.id)) ?? []) : [],
      };
    });

    return { items, canSeeAmounts: canMoney };
  }
}
