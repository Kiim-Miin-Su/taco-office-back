/** @file-guide
 * 목적: lead-plan.service.ts — LeadPlanService, LEAD_PLAN_JSON, LEAD_APPTS_JSON, leadPlanFromRow, leadApptsFromRow (service)
 * 책임/재사용: 상담 배치안 초안 · 2차/진단 일정 · 보류 연장의 읽기 조각(상담 한 줄 SELECT 에 붙는다)과 쓰기를 소유한다. 시간표 회차는 기존 ScheduleWriteService.create 로만 만든다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 원본 §23 카드가 **담을 곳이 없어** 못 그리던 셋 (wave3 g3 · 23-15 · 23-16 · 24-07).
 *
 * - 배치안 초안(`lead_plan`) — 「SAT Reading 주2 · Rebecca」. 한 건의 줄을 통째로 바꿔 적는다. 단가는 적지 않고
 *   **적은 날의 단가표(RATE)** 를 읽을 때 붙인다 — 청구서 줄(invoice-lines)과 같은 고르기(과목 단가 우선 · 인원 구간 1인)다.
 *   금액을 볼 수 없는 사람에게는 null 이다(D-R39).
 * - 보류 재확인(`lead.recheck_on`) — 비면 보류에 들어온 날 + 2일. 「연장 +2일」은 그 유효 날짜에 이틀을 더해 적는다.
 * - 2차 · 진단 일정(`lead_appt`) — 종류마다 한 줄. 「스케줄에 N건 만들기」가 시간표 회차(ONCE)를 **있는 길**
 *   (`ScheduleWriteService.create`)로 만들고 `ser_id` 로 잇는다. 겹침은 시간표의 EXCLUDE 가 막는다(회의 잡기 · C96 과 같은 길).
 *   이은 뒤의 날짜·시각·강의실은 시간표가 정본이라 읽기도 그 회차를 따른다(두 곳이면 옮겼을 때 갈린다 · D-R22).
 *
 * - A-02 「상담 일정 잡기」(`bookAppt`) — 적기 · 시간표 회차 · 담당 지정 · 1차 → 2차 대기 · 상담 예약 접촉을 **한 트랜잭션**에서 한다.
 *   적기(`upsertAppt`)와 회차 만들기(`createApptSer`)는 위 둘과 같은 함수이고, 단계 이동은 전이표(`leadNextStages`)를 본다.
 *
 * 쓰기는 깔때기 안(1차 · 2차 대기 · 2차 상담 · 보류)에서만 한다 — 등록 건은 시간표가, 실패 건은 「당시」 기록이 정본이다.
 * 응답(LeadDto)은 컨트롤러가 `OpsService.leadOne` 으로 만든다 — 상담 한 줄의 모양은 한 곳이다(C90).
 */
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  INTAKE_FUNNEL_STAGES, LEAD_APPT_SER_CODE, intakeStageLabel, leadApptKindLabel, leadApptPlaceLabel,
  leadHoldExtended, leadNextStages, leadPlanLineLabel, leadRecheckOn, type LeadApptKind,
} from '../../lib/intake-words';
import { todayKst } from '../../lib/kst';
import { END_MIN, START_MIN, effectiveModeOf, kstDateOf } from '../../lib/sql';
import { ScheduleWriteService } from '../schedule/schedule.write.service';
import type { LeadApptBookDto, LeadApptDto, LeadApptWriteDto, LeadPlanLineDto, LeadPlanWriteDto } from './lead-plan.dto';

type R = Record<string, unknown>;

/**
 * 상담 한 줄(`FROM lead l`)에 붙는 배치안 줄 — JSON 한 칸(`plan_json`). 카드마다 묻지 않는다(왕복 0 · DQ1 진단 줄과 같은 규약).
 * 단가는 청구서 줄의 고르기와 같다 — 과목 단가가 있으면 그것, 없으면 종류 단가 · 인원 구간은 새 학생 한 명(heads ≤ 1) · 그 줄을 적은 날(KST) 기준.
 */
export const LEAD_PLAN_JSON = `(SELECT COALESCE(json_agg(json_build_object(
           'seq', p.seq, 'kind_key', p.kind_key, 'kind_name', k.name, 'sub_key', p.sub_key, 'sub_name', sb.name,
           'per_week', p.per_week, 'teacher_id', p.teacher_id, 'teacher_name', t.name,
           'unit_price', (SELECT r.unit_price FROM rate r
                           WHERE r.kind_key = p.kind_key AND (r.sub_key IS NULL OR r.sub_key = p.sub_key)
                             AND r.heads <= 1 AND r.from_date <= ${kstDateOf('p.created_at')}
                           ORDER BY r.sub_key NULLS LAST, r.heads DESC, r.from_date DESC, r.id DESC LIMIT 1)
         ) ORDER BY p.seq), '[]'::json)
         FROM lead_plan p JOIN kind k ON k.key = p.kind_key
         LEFT JOIN sub sb ON sb.key = p.sub_key LEFT JOIN staff t ON t.id = p.teacher_id
        WHERE p.lead_id = l.id) AS plan_json`;

/**
 * 상담 한 줄에 붙는 2차 · 진단 일정 — JSON 한 칸(`appts_json`). 시간표에 만든 줄은 **그 회차의 첫 날**(ser_occ)을 읽는다.
 * 종류 이름 순(diag < second)이라 「진단」이 앞이다(원본 §23 카드 순서).
 */
export const LEAD_APPTS_JSON = `(SELECT COALESCE(json_agg(json_build_object(
           'kind', a.kind,
           'on_date', to_char(COALESCE(oc.on_date, a.on_date),'YYYY-MM-DD'),
           'start_min', COALESCE(oc.start_min, a.start_min), 'end_min', COALESCE(oc.end_min, a.end_min),
           'mode', COALESCE(oc.mode, a.mode),
           'room_id', CASE WHEN oc.ser_id IS NOT NULL THEN oc.room_id ELSE a.room_id END,
           'room_name', rm.name, 'ser_id', a.ser_id
         ) ORDER BY a.kind), '[]'::json)
         FROM lead_appt a
         LEFT JOIN LATERAL (
           SELECT o.ser_id, ${kstDateOf('lower(o.span)')} AS on_date, ${START_MIN} AS start_min, ${END_MIN} AS end_min,
                  -- 그 회차의 실제 방식 — 회차 예외가 그날만 바꿨으면 그 값(W11 A' · N-56 · 규칙의 칸만 읽으면 옛 방식이 보인다)
                  ${effectiveModeOf('ex', 's')} AS mode, COALESCE(o.room_id, s.room_id) AS room_id
             FROM ser_occ o JOIN ser s ON s.id = o.ser_id
             LEFT JOIN exc ex ON ex.ser_id = o.ser_id AND ex.on_date = o.on_date
            WHERE o.ser_id = a.ser_id
            ORDER BY lower(o.span), o.id LIMIT 1
         ) oc ON true
         LEFT JOIN room rm ON rm.id = CASE WHEN oc.ser_id IS NOT NULL THEN oc.room_id ELSE a.room_id END
        WHERE a.lead_id = l.id) AS appts_json`;

/** pg bigint 문자열 → 안전 정수. 오염된 연결은 조용히 0/NaN 으로 두지 않는다 (ops.service `leadId` 와 같은 규약) */
function toId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new InternalServerErrorException('상담 데이터 무결성 오류');
  return id;
}
const optId = (value: unknown): number | null => (value == null ? null : toId(value));
const text = (value: unknown): string | null => (value == null ? null : String(value));
const rowsOf = (value: unknown): R[] => (Array.isArray(value) ? (value as R[]) : []);

/** `plan_json` → 배치안 줄. 단가는 금액을 볼 수 있을 때만 (D-R39) */
export function leadPlanFromRow(r: R, canSeeAmounts: boolean): LeadPlanLineDto[] {
  return rowsOf(r.plan_json).map((p) => {
    const perWeek = Number(p.per_week);
    const kindLabel = text(p.kind_name) ?? String(p.kind_key);
    const subLabel = text(p.sub_name);
    const teacherName = text(p.teacher_name);
    return {
      seq: Number(p.seq), kindKey: String(p.kind_key), kindLabel,
      subKey: text(p.sub_key), subLabel, perWeek,
      teacherId: optId(p.teacher_id), teacherName,
      label: leadPlanLineLabel({ subName: subLabel, kindName: kindLabel, perWeek, teacherName }),
      unitPrice: canSeeAmounts && p.unit_price != null ? Number(p.unit_price) : null,
    };
  });
}

/** `appts_json` → 일정 줄. 「미생성」은 시간표 회차 연결이 없다는 뜻이다 */
export function leadApptsFromRow(r: R): LeadApptDto[] {
  return rowsOf(r.appts_json).map((a) => {
    const kind = String(a.kind);
    const mode = String(a.mode);
    const serId = optId(a.ser_id);
    return {
      kind, kindLabel: leadApptKindLabel(kind), onDate: String(a.on_date),
      startMin: Number(a.start_min), endMin: Number(a.end_min), mode,
      roomId: optId(a.room_id), placeLabel: leadApptPlaceLabel(mode, text(a.room_name)),
      serId, scheduled: serId !== null,
    };
  });
}

const FUNNEL = INTAKE_FUNNEL_STAGES as readonly string[];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

type Unav = { serId: number; date: string; teacherId: number; teacherName: string; startMin: number; endMin: number; reason: string };

/** 적기의 모양 판정 — 끝이 시작보다 뒤 · 온라인에는 강의실 없음. 강의실(현장일 때만)을 돌려준다 */
function apptRoomOf(dto: LeadApptWriteDto): number | null {
  if (dto.endMin <= dto.startMin) throw new ConflictException({ code: 'BAD_RANGE', message: '끝나는 시각이 시작보다 뒤여야 합니다' });
  if (dto.mode === 'online' && dto.roomId != null) {
    throw new ConflictException({ code: 'LEAD_APPT_PLACE', message: '온라인 일정에는 강의실을 고르지 않습니다' });
  }
  return dto.mode === 'offline' ? dto.roomId ?? null : null;
}

@Injectable()
export class LeadPlanService {
  constructor(
    private readonly ds: DataSource,
    /** 「스케줄에 N건 만들기」 — 시간표 회차는 있는 길로만 만든다(겹침 · 투영 · 불가 시간이 거기 있다) */
    private readonly schedule: ScheduleWriteService,
  ) {}

  /** 상담 건을 잠그고 읽는다 — 깔때기 밖이면 그 이유로 막는다(쓰기마다 같은 문장) */
  private async lockOpen(m: EntityManager, id: number, lockedCode: string, what: string): Promise<{ stage: string; name: string; ownerId: number | null }> {
    const [lead] = (await m.query(`SELECT id, stage, name, owner_id FROM lead WHERE id = $1 FOR UPDATE`, [id])) as R[];
    if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
    const stage = String(lead.stage);
    if (!FUNNEL.includes(stage)) {
      throw new ConflictException({
        code: lockedCode,
        message: `${intakeStageLabel(stage)} 건은 ${what}을 고치지 않습니다 — ${stage === 'enrolled' ? '등록 뒤에는 시간표가 정본입니다' : '실패 당시 기록으로 남깁니다'}`,
      });
    }
    return { stage, name: String(lead.name), ownerId: optId(lead.owner_id) };
  }

  /**
   * 배치안 통째로 바꾸기 (23-16) — 지난 줄을 지우고 보낸 줄을 차례대로 적는다. 빈 배열이면 초안을 비운다.
   * 종류·과목은 코드표에, 강사는 재직 중인 사람에 있어야 한다(표의 FK 가 마지막으로 막는다 — 여기서는 사람이 읽을 문장으로 먼저 막는다).
   */
  async savePlan(viewerId: number, id: number, dto: LeadPlanWriteDto): Promise<void> {
    const lines = dto.lines.map((l) => ({
      kindKey: l.kindKey.trim(), subKey: l.subKey?.trim() || null, perWeek: l.perWeek, teacherId: l.teacherId ?? null,
    }));
    await this.ds.transaction(async (m) => {
      await this.lockOpen(m, id, 'LEAD_PLAN_LOCKED', '배치안');
      const kinds = [...new Set(lines.map((l) => l.kindKey))];
      const subs = [...new Set(lines.map((l) => l.subKey).filter((k): k is string => k !== null))];
      const teachers = [...new Set(lines.map((l) => l.teacherId).filter((t): t is number => t !== null))];
      if (kinds.length) {
        const found = (await m.query(`SELECT key FROM kind WHERE key = ANY($1)`, [kinds])) as R[];
        if (found.length !== kinds.length) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '고른 종류가 코드표에 없습니다 — 목록을 다시 불러와 골라 주세요' });
      }
      if (subs.length) {
        const found = (await m.query(`SELECT key FROM sub WHERE key = ANY($1)`, [subs])) as R[];
        if (found.length !== subs.length) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: '고른 과목이 코드표에 없습니다 — 목록을 다시 불러와 골라 주세요' });
      }
      if (teachers.length) {
        const found = (await m.query(`SELECT id FROM staff WHERE id = ANY($1::bigint[]) AND active`, [teachers])) as R[];
        if (found.length !== teachers.length) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '고른 강사를 찾을 수 없습니다 — 재직 중인 사람만 고릅니다' });
      }
      const before = (await m.query(
        `SELECT kind_key AS "kindKey", sub_key AS "subKey", per_week AS "perWeek", teacher_id AS "teacherId" FROM lead_plan WHERE lead_id = $1 ORDER BY seq`, [id],
      )) as R[];
      await m.query(`DELETE FROM lead_plan WHERE lead_id = $1`, [id]);
      for (const [i, l] of lines.entries()) {
        await m.query(
          `INSERT INTO lead_plan (lead_id, seq, kind_key, sub_key, per_week, teacher_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, i + 1, l.kindKey, l.subKey, l.perWeek, l.teacherId, viewerId],
        );
      }
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'plan',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ lines: before.map((b) => ({ ...b, teacherId: optId(b.teacherId) })) }), JSON.stringify({ lines })],
      );
    });
  }

  /**
   * 「연장 +2일」 (23-16) — 보류 건의 유효 재확인 날짜(적어 둔 날짜 · 없으면 보류에 들어온 날 + 2일)에 이틀을 더해 적는다.
   * 유효 날짜를 모르는 옛 건은 오늘에서 센다 — 사람이 지금 누른 것이라 지난 날짜를 짓는 것이 아니다.
   */
  async extendHold(viewerId: number, id: number): Promise<void> {
    await this.ds.transaction(async (m) => {
      const [lead] = (await m.query(
        `SELECT l.stage, to_char(l.recheck_on,'YYYY-MM-DD') AS recheck_on,
                (SELECT to_char(${kstDateOf('max(g.at)')},'YYYY-MM-DD') FROM lead_stage_log g WHERE g.lead_id = l.id AND g.stage = 'hold') AS entered_on
           FROM lead l WHERE l.id = $1 FOR UPDATE OF l`, [id],
      )) as R[];
      if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: '상담 건을 찾을 수 없습니다' });
      if (String(lead.stage) !== 'hold') {
        throw new ConflictException({ code: 'LEAD_NOT_HOLD', message: `${intakeStageLabel(String(lead.stage))} 건입니다 — 연장은 보류 건만 합니다` });
      }
      const current = leadRecheckOn('hold', text(lead.recheck_on), text(lead.entered_on));
      const next = leadHoldExtended(current, todayKst());
      await m.query(`UPDATE lead SET recheck_on = $2::date WHERE id = $1`, [id, next]);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'hold_extend',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ recheckOn: current }), JSON.stringify({ recheckOn: next })],
      );
    });
  }

  /**
   * 2차 · 진단 일정 한 줄 적기 (23-15) — 종류마다 한 줄이라 같은 종류를 다시 보내면 고쳐 적는다.
   * 이미 시간표에 만든 줄은 여기서 못 고친다 — 시간표가 정본이다(옮기면 카드도 따라간다).
   */
  async saveAppt(viewerId: number, id: number, dto: LeadApptWriteDto): Promise<void> {
    const roomId = apptRoomOf(dto);
    await this.ds.transaction(async (m) => {
      await this.lockOpen(m, id, 'LEAD_APPT_LOCKED', '일정');
      const { before, after } = await this.upsertAppt(m, viewerId, id, dto, roomId);
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'appt',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify(before), JSON.stringify(after)],
      );
    });
  }

  /** 일정 한 줄 적기의 몸통 — 강의실 확인 · 시간표에 만든 줄은 409 · 종류마다 한 줄(upsert). 잠금은 부르는 쪽이 쥔다 */
  private async upsertAppt(
    m: EntityManager, viewerId: number, id: number, dto: LeadApptWriteDto, roomId: number | null,
  ): Promise<{ apptId: number; before: Record<string, unknown>; after: Record<string, unknown> }> {
    if (roomId !== null) {
      const [room] = (await m.query(`SELECT id FROM room WHERE id = $1 AND active`, [roomId])) as R[];
      if (!room) throw new NotFoundException({ code: 'ROOM_NOT_FOUND', message: '고른 강의실을 찾을 수 없습니다' });
    }
    const [cur] = (await m.query(
      `SELECT kind, to_char(on_date,'YYYY-MM-DD') AS "onDate", start_min AS "startMin", end_min AS "endMin", mode, room_id AS "roomId", ser_id
         FROM lead_appt WHERE lead_id = $1 AND kind = $2`, [id, dto.kind],
    )) as R[];
    if (cur?.ser_id != null) {
      throw new ConflictException({
        code: 'LEAD_APPT_SCHEDULED',
        message: `${leadApptKindLabel(dto.kind)} 일정은 이미 시간표에 만들었습니다 — 시간표에서 옮기면 카드도 따라갑니다`,
      });
    }
    const [row] = (await m.query(
      `INSERT INTO lead_appt (lead_id, kind, on_date, start_min, end_min, mode, room_id, created_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       ON CONFLICT (lead_id, kind) DO UPDATE
         SET on_date = EXCLUDED.on_date, start_min = EXCLUDED.start_min, end_min = EXCLUDED.end_min,
             mode = EXCLUDED.mode, room_id = EXCLUDED.room_id
       RETURNING id`,
      [id, dto.kind, dto.onDate, dto.startMin, dto.endMin, dto.mode, roomId, viewerId],
    )) as R[];
    const after = { kind: dto.kind, onDate: dto.onDate, startMin: dto.startMin, endMin: dto.endMin, mode: dto.mode, roomId };
    const before = cur ? { kind: cur.kind, onDate: cur.onDate, startMin: cur.startMin, endMin: cur.endMin, mode: cur.mode, roomId: optId(cur.roomId) } : {};
    return { apptId: toId(row.id), before, after };
  }

  /**
   * 2차 · 진단 일정 한 줄 지우기 (23-15 · impl3-w8) — 잘못 잡은 일정을 카드에서 걷어낸다.
   * **시간표에 만든 줄은 지우지 않는다** — 그 회차에는 리포트·출결·안내가 붙을 수 있고 시간표가 정본이라(D-R22),
   * 여기서 회차를 지우면 시간표 쓰기의 방어(월 마감 · 이력 보존 · 되돌리기)를 건너뛴다. 시간표에서 지우면 연결이 풀려
   * 다시 「미생성」 줄이 되고, 그때 여기서 지운다. 깔때기 밖(등록 · 실패)은 적기와 같은 문장으로 막는다.
   */
  async deleteAppt(viewerId: number, id: number, kind: string): Promise<void> {
    await this.ds.transaction(async (m) => {
      await this.lockOpen(m, id, 'LEAD_APPT_LOCKED', '일정');
      const [cur] = (await m.query(
        `SELECT id, kind, to_char(on_date,'YYYY-MM-DD') AS "onDate", start_min AS "startMin", end_min AS "endMin", mode, room_id AS "roomId", ser_id
           FROM lead_appt WHERE lead_id = $1 AND kind = $2 FOR UPDATE`, [id, kind],
      )) as R[];
      if (!cur) {
        throw new NotFoundException({ code: 'LEAD_APPT_NOT_FOUND', message: `${leadApptKindLabel(kind)} 일정이 없습니다 — 목록을 다시 불러와 주세요` });
      }
      if (cur.ser_id != null) {
        throw new ConflictException({
          code: 'LEAD_APPT_SCHEDULED',
          message: `${leadApptKindLabel(kind)} 일정은 이미 시간표에 만들었습니다 — 시간표에서 그 회차를 지우면 여기서도 지울 수 있습니다`,
        });
      }
      await m.query(`DELETE FROM lead_appt WHERE id = $1`, [cur.id]);
      const before = { kind: cur.kind, onDate: cur.onDate, startMin: cur.startMin, endMin: cur.endMin, mode: cur.mode, roomId: optId(cur.roomId) };
      await m.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'appt_delete',$3::jsonb,'{}'::jsonb)`,
        [viewerId, id, JSON.stringify(before)],
      );
    });
  }

  /**
   * 「스케줄에 N건 만들기」 (23-15) — 아직 시간표에 없는 일정마다 한 번(ONCE) 회차를 만들고 잇는다. 한 트랜잭션이다.
   * 진단 = 「진단고사」 종류, 2차 = 「상담」 종류(코드표). 강사 자리는 상담 담당이다 — 담당이 겹치면 시간표가 막는다.
   * 담당이 적어 둔 불가 시간은 막지 않고 경고로 돌려준다(시간표 쓰기와 같은 규약).
   */
  async scheduleAppts(viewerId: number, id: number): Promise<{ created: number; unavailable: Array<{ serId: number; date: string; teacherId: number; teacherName: string; startMin: number; endMin: number; reason: string }> }> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const lead = await this.lockOpen(q.manager, id, 'LEAD_APPT_LOCKED', '일정');
      const todo = (await q.query(
        `SELECT id, kind, to_char(on_date,'YYYY-MM-DD') AS on_date, start_min, end_min, mode, room_id
           FROM lead_appt WHERE lead_id = $1 AND ser_id IS NULL ORDER BY kind FOR UPDATE`, [id],
      )) as R[];
      if (!todo.length) throw new ConflictException({ code: 'LEAD_APPT_NONE', message: '시간표에 만들 일정이 없습니다 — 2차·진단 일정을 먼저 잡아 주세요' });
      await this.assertApptCodes(q, todo.map((a) => String(a.kind)));
      const unavailable: Unav[] = [];
      for (const a of todo) {
        const written = await this.createApptSer(q, viewerId, {
          apptId: toId(a.id), kind: String(a.kind), onDate: String(a.on_date), startMin: Number(a.start_min), endMin: Number(a.end_min),
          mode: String(a.mode), roomId: optId(a.room_id), teacherId: lead.ownerId, leadName: lead.name,
        });
        unavailable.push(...written.unavailable);
      }
      await q.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'appt_schedule','{}'::jsonb,$3::jsonb)`,
        [viewerId, id, JSON.stringify({ kinds: todo.map((a) => String(a.kind)), created: todo.length })],
      );
      await q.commitTransaction();
      return { created: todo.length, unavailable };
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
  }

  /**
   * A-02 「상담 일정 잡기」 — ① 카드 → 상담 일정 잡기 ② 날짜 · 시각 ③ 담당 지정 · 방식 ④ 저장. **한 트랜잭션**이다.
   *   적기(`upsertAppt` · 적기와 같은 함수) → 담당 지정(카드 담당이 바뀐다) → 시간표 회차(`createApptSer` · 강사 자리 = 담당)
   *   → 1차면 2차 대기로(전이표 · 도달 기록 · 재확인 날짜 비움 — 단계 이동과 같은 줄) → 상담 예약 접촉(`book` · 다음은 그날 — A-03 의 「상담 오늘 · 지남」이 이 날짜를 본다) → LOG.
   * 겹치면 시간표가 막고 **전부** 되돌아간다 — 「일정은 적혔는데 시간표에 없다」 · 「단계만 옮겨졌다」가 생기지 않는다(A-02 「이러면 실패」).
   * 이미 시간표에 만든 종류는 409(시간표에서 옮긴다) · 2차 대기 이후 건은 단계를 옮기지 않는다(앞으로만 · 전이표).
   */
  async bookAppt(viewerId: number, id: number, dto: LeadApptBookDto): Promise<{ created: number; unavailable: Unav[] }> {
    const roomId = apptRoomOf(dto);
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const lead = await this.lockOpen(q.manager, id, 'LEAD_APPT_LOCKED', '일정');
      const [owner] = (await q.query(`SELECT id, name FROM staff WHERE id = $1 AND active`, [dto.ownerId])) as R[];
      if (!owner) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: '고른 담당을 찾을 수 없습니다 — 재직 중인 사람만 고릅니다' });
      await this.assertApptCodes(q, [dto.kind]);
      const { apptId } = await this.upsertAppt(q.manager, viewerId, id, dto, roomId);
      if (lead.ownerId !== dto.ownerId) await q.query(`UPDATE lead SET owner_id = $2 WHERE id = $1`, [id, dto.ownerId]);
      const { serId, unavailable } = await this.createApptSer(q, viewerId, {
        apptId, kind: dto.kind, onDate: dto.onDate, startMin: dto.startMin, endMin: dto.endMin, mode: dto.mode, roomId,
        teacherId: dto.ownerId, leadName: lead.name,
      });
      // 1차에서 잡으면 다음 칸은 2차 대기다(원본 §23 · A-02 「카드가 1차 → 2차 대기로 이동한다」) — 전이표 밖으로는 옮기지 않는다
      const moved = lead.stage === 'first' && (leadNextStages(lead.stage) as readonly string[]).includes('wait2nd');
      if (moved) {
        await q.query(`UPDATE lead SET stage = 'wait2nd', recheck_on = NULL WHERE id = $1`, [id]);
        await q.query(`INSERT INTO lead_stage_log (lead_id, stage, by_id) VALUES ($1, 'wait2nd', $2)`, [id, viewerId]);
      }
      const [room] = roomId === null ? [] : (await q.query(`SELECT name FROM room WHERE id = $1`, [roomId])) as R[];
      const code = LEAD_APPT_SER_CODE[dto.kind as LeadApptKind];
      await q.query(
        `INSERT INTO lead_touch (lead_id, kind, note, next_on, by_id) VALUES ($1, 'book', $2, $3::date, $4)`,
        [id, `${code.title} 예약 — ${dto.onDate.slice(5)} ${hm(dto.startMin)} · ${leadApptPlaceLabel(dto.mode, text(room?.name))} · 담당 ${String(owner.name)}`, dto.onDate, viewerId],
      );
      await q.query(
        `INSERT INTO log (actor_id, entity, entity_id, action, before, after) VALUES ($1,'LEAD',$2,'appt_book',$3::jsonb,$4::jsonb)`,
        [viewerId, id, JSON.stringify({ stage: lead.stage, ownerId: lead.ownerId }), JSON.stringify({
          kind: dto.kind, onDate: dto.onDate, startMin: dto.startMin, endMin: dto.endMin, mode: dto.mode, roomId,
          ownerId: dto.ownerId, serId, stage: moved ? 'wait2nd' : lead.stage,
        })],
      );
      await q.commitTransaction();
      return { created: 1, unavailable };
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
  }

  /** 시간표 코드표에 그 종류의 짝(진단고사 · 상담)이 있어야 만든다 — 없으면 사람이 읽을 문장으로 막는다 */
  private async assertApptCodes(q: QueryRunner, kinds: string[]): Promise<void> {
    const codes = [...new Set(kinds.map((k) => LEAD_APPT_SER_CODE[k as LeadApptKind]))];
    const [known] = (await q.query(
      `SELECT (SELECT count(*)::int FROM kind WHERE key = ANY($1)) AS kinds, (SELECT count(*)::int FROM sub WHERE key = ANY($2)) AS subs`,
      [codes.map((c) => c.kindKey), codes.map((c) => c.subKey)],
    )) as R[];
    if (Number(known.kinds) !== codes.length || Number(known.subs) !== codes.length) {
      throw new ConflictException({ code: 'LEAD_APPT_CODE_MISSING', message: '시간표 코드표에 「진단고사」·「상담」 종류가 없어 만들 수 없습니다 — 코드표를 먼저 채워 주세요' });
    }
  }

  /**
   * 일정 한 줄의 시간표 회차(ONCE)를 **있는 길**(`ScheduleWriteService.create`)로 만들고 잇는다 — 「스케줄에 N건 만들기」와 A-02 가 같이 쓴다.
   * 겹침은 시간표(EXCLUDE · pg 23P01)가 막는다 — **무엇과** 부딪혔는지만 문장에 보탠다(회의 잡기 · C96 과 같은 자리).
   */
  private async createApptSer(q: QueryRunner, viewerId: number, a: {
    apptId: number; kind: string; onDate: string; startMin: number; endMin: number; mode: string; roomId: number | null; teacherId: number | null; leadName: string;
  }): Promise<{ serId: number; unavailable: Unav[] }> {
    const code = LEAD_APPT_SER_CODE[a.kind as LeadApptKind];
    let serId: number;
    let unavailable: Unav[];
    try {
      const written = await this.schedule.create({
        kindKey: code.kindKey, subKey: code.subKey, mode: a.mode,
        fromDate: a.onDate, toDate: a.onDate, rrule: 'ONCE', startMin: a.startMin, endMin: a.endMin,
        teacherId: a.teacherId, roomId: a.roomId, title: `${a.leadName} ${code.title}`, studentIds: [],
      }, viewerId, q);
      serId = written.serIds[0]!;
      unavailable = written.unavailable;
    } catch (e) {
      const pg = (e as { driverError?: { code?: string }; code?: string }) ?? {};
      if ((pg.driverError?.code ?? pg.code) === '23P01') {
        throw new ConflictException({
          code: 'RESOURCE_CONFLICT',
          message: `같은 시간에 담당·강의실이 이미 잡혀 있습니다 — ${leadApptKindLabel(a.kind)} · ${a.onDate} ${hm(a.startMin)}`,
        });
      }
      throw e;
    }
    await q.query(`UPDATE lead_appt SET ser_id = $2 WHERE id = $1`, [a.apptId, serId]);
    return { serId, unavailable };
  }
}
