import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import { csCan, csCanAmount, csCanFull, type ConsShare, type ConsViewer } from '../../lib/rules';
import type { ConsultingListDto, ConsultingSessionDto } from './consulting.dto';

type R = Record<string, unknown>;

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

    const logs = await this.q(
      `SELECT id, cons_id, seq, to_char(on_date,'YYYY-MM-DD') AS on_date, who, what, why, how, ser_id
         FROM cons_sess ORDER BY cons_id, seq`,
    );
    const byCons = new Map<number, ConsultingSessionDto[]>();
    for (const r of logs) {
      const k = Number(r.cons_id);
      if (!byCons.has(k)) byCons.set(k, []);
      byCons.get(k)!.push({
        id: Number(r.id), seq: Number(r.seq), onDate: String(r.on_date),
        who: (r.who as string) ?? null, what: (r.what as string) ?? null,
        why: (r.why as string) ?? null, how: (r.how as string) ?? null,
        serId: r.ser_id === null || r.ser_id === undefined ? null : Number(r.ser_id),
      });
    }

    const items = rows
      .map((r) => {
        const share = String(r.share) as ConsShare;
        const v: ConsViewer = {
          isOwner: Number(r.owner_id) === viewerId,
          isPicked: r.is_picked === true,
          canHide,
          canMoney,
        };
        if (!csCan(share, v)) return null; // 목록에서 아예 뺀다 — 「있다」는 사실도 안 흘린다

        const full = csCanFull(share, v);
        const money = csCanAmount(share, v);

        return {
          id: Number(r.id),
          consType: String(r.cons_type),
          stage: String(r.stage),
          share,
          contractStep: r.contract_step === null || r.contract_step === undefined
            ? null : Number(r.contract_step),
          studentNames: (r.student_names as string[]) ?? [],
          ownerName: (r.owner_name as string) ?? null,
          sessions: r.sessions === null || r.sessions === undefined ? null : Number(r.sessions),
          endOn: (r.end_on as string) ?? null,
          createdAt: String(r.created_at),
          amount: money && r.amount !== null && r.amount !== undefined ? Number(r.amount) : null,
          canOpen: full,
          // 내용이 안 열리면 회차 기록도 내려보내지 않는다 — 화면에서 감추는 건 감춘 게 아니다
          sessionsLog: full ? (byCons.get(Number(r.id)) ?? []) : [],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items, canSeeAmounts: canMoney };
  }
}
