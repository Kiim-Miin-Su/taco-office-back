/** @file-guide
 * 목적: schedule.write.service.ts — ScheduleWriteService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 스케줄 쓰기 — **네 단계뿐이다.**
 *
 *   load    DB → State
 *   reduce  lib/recurrence.ts 의 순수 함수 (여기서 3범위가 갈린다)
 *   persist State 차이를 SQL 로
 *   project occ() 결과를 ser_occ 로 → EXCLUDE 가 최종 판정
 *
 * 규칙은 이 파일에 **한 줄도 없다.** 3범위 판정을 여기서 다시 쓰면
 * `recurrence.spec.ts` 85 어서션이 지키지 않는 두 번째 구현이 생긴다.
 *
 * 네 단계는 한 트랜잭션이다 (D-R43 ① 경계). 겹치면 EXCLUDE 가 23P01 을 던지고
 * 트랜잭션이 통째로 되돌아간다 — 절반만 저장된 시간표가 남지 않는다.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  applyCreate, applyDelete, applyEdit, applyPaste, applyRoster, copyMany, formatRule, occ,
  lessonTimeIssue, parseRuleInput, pasteIssue, rosterAt, rosterScopes, ruleHits, scheduleTimeIssue,
  type Patch as OccurrencePatch, type Scope, type State,
} from '../../lib/recurrence';
import {
  rosterPricing, GUIDE_DONE_DB, cancelPolicyIssue, CANCEL_POLICY_MESSAGE, CANCEL_TREAT_LABEL,
  type AttendanceCancelReason, type CancelTreat,
} from '../../lib/rules';
import { isIsoDate } from '../../lib/kst';
import { START_MIN, END_MIN, kstDateOf } from '../../lib/sql';
import { closedMonths, closedOccSnapshot, monthClosedError, monthOf } from '../../lib/month-close';
import { loadState, persist } from './schedule.state.repo';
import { issueScheduleUndo, readScheduleUndo, sameScheduleState } from './schedule.undo';
import { assertScheduleReferences } from './schedule.references';
import { horizon, project } from './schedule.project';
import type {
  DayCancelDto, DayCancelResultDto,
  OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceMoveDto, OccurrencePasteDto, OccurrencePatchDto,
  RosterPatchDto, RosterResultDto, UnavWarnDto, WriteResultDto,
} from './schedule.dto';

/**
 * 휴강의 사유·처리 — DTO 의 두 칸을 정책으로 판정한다 (C92 · lib/rules 한 곳).
 * 둘 다 비우면 옛 방식(취소만) 이고, 하나만 오면 400 이다 — 반쪽 기록은 「이월인지 차감인지」를 나중에 못 읽는다.
 */
function cancelArgs(dto: { cancelKind?: AttendanceCancelReason; cancelTreat?: CancelTreat; memo?: string }) {
  if (dto.cancelKind === undefined && dto.cancelTreat === undefined) return undefined;
  const issue = cancelPolicyIssue({ kind: dto.cancelKind ?? null, treat: dto.cancelTreat ?? 'carry' });
  if (issue) throw new BadRequestException({ code: issue, message: CANCEL_POLICY_MESSAGE[issue] });
  return { kind: dto.cancelKind as string, treat: (dto.cancelTreat ?? 'carry') as string, memo: dto.memo?.trim() || null };
}

/**
 * 휴강 알림 두 건 (테스트 시나리오 M-125) — 같은 트랜잭션에서 남긴다 (D-R43).
 *   ① 「{과목} 결강 — {학생들} → 스케줄」   그 회차의 강사와 관리자 전원(본인 제외)
 *   ② 「{과목} 이월 1회 발생 — {학생들} → 회계」   이월일 때만, 회계를 보는 대표에게 — 다음 달 청구에서 빠진다는 문구를 함께
 * **회차마다 한 건**이다 — 학생마다 남기면 네 명 반의 휴강 하나가 수신함에 넉 줄로 서고, 「알림 2건」이 여덟이 된다.
 * 낱말은 서버가 만든다 (D-R18). 화면은 body 를 그대로 보여 준다.
 */
async function notifyCancel(
  q: QueryRunner, actorId: number | undefined, serId: number, onDate: string, fresh: State, treat: string,
  makeup?: { date: string; startMin: number },
): Promise<void> {
  const ser = fresh.SER.find((s) => s.id === serId);
  if (!ser) return;
  const exc = fresh.EXC.find((e) => e.serId === serId && e.onDate === onDate);
  const teacherId = exc?.teacherSet ? exc.teacherId : ser.teacherId;
  const studentIds = rosterAt(fresh, serId, onDate);
  const [head] = await q.query(
    `SELECT COALESCE(sb.name, k.name) AS subject,
            (SELECT string_agg(st.name, ' · ' ORDER BY st.name) FROM stu st WHERE st.id = ANY($2::bigint[])) AS students
       FROM ser s
       JOIN kind k ON k.key = s.kind_key
       LEFT JOIN sub sb ON sb.key = s.sub_key
      WHERE s.id = $1`,
    [serId, studentIds],
  ) as Array<{ subject: string; students: string | null }>;
  if (!head) return;
  const who = head.students ?? '학생 없음';
  const month = onDate.slice(0, 7);
  const treatLabel = CANCEL_TREAT_LABEL[treat as CancelTreat] ?? '이월';
  // 보강 이관이면 「언제 보강인지」까지 한 문장에 — 강사·관리자가 새 회차를 따로 찾지 않게 (C-34)
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const treatText = makeup ? `${treatLabel} → ${makeup.date} ${hhmm(makeup.startMin)}` : treatLabel;
  await q.query(
    `INSERT INTO noti (to_id, from_id, body, link, category)
     SELECT id, $1, $2, $3, 'schedule' FROM staff
      WHERE active AND (id = $4 OR role <> 'teacher') AND ($1::bigint IS NULL OR id <> $1)`,
    [actorId ?? null, `${head.subject} 결강 — ${who} (${onDate} · ${treatText})`, `/schedule?date=${onDate}`, teacherId ?? -1],
  );
  if (treat === 'carry') {
    await q.query(
      `INSERT INTO noti (to_id, from_id, body, link, category)
       SELECT id, $1, $2, $3, 'schedule' FROM staff
        WHERE active AND role = 'ceo' AND ($1::bigint IS NULL OR id <> $1)`,
      [actorId ?? null, `${head.subject} 이월 1회 발생 — ${who} · 다음 달 청구에서 빠집니다 (${onDate})`, `/accounting?tab=tuition&month=${month}`],
    );
  }
}

/**
 * 강사 불가 시간과 겹친 회차 — **막지 않고 알린다** (원본 §15·§16).
 *
 * UNAV 는 DB 제약이 아니다. 급할 때 관리자가 그 위에 잡는 일이 실제로 있고, 그것까지 막으면
 * 제품이 현장을 이긴다. 다만 **지금까지는 말조차 하지 않았다** — 관리자 화면 어디에도
 * UNAV 가 없어 **적어 낸 강사만 알고 잡는 사람은 몰랐다.**
 *
 * 쓰기가 끝난 트랜잭션 안에서 한 번 훑는다 — 왕복을 더하지 않는다. 지난 날은 고칠 수 없으니
 * 오늘부터 보고, 취소된 회차는 자리를 비우는 쪽이라 세지 않는다. 열 줄에서 끊는다(경고는
 * 읽히지 않으면 없는 것과 같다).
 */
async function unavailableOverlaps(q: QueryRunner, serIds: number[]): Promise<UnavWarnDto[]> {
  if (serIds.length === 0) return [];
  const rows = (await q.query(
    `SELECT o.ser_id, to_char(${kstDateOf('lower(o.span)')}, 'YYYY-MM-DD') AS date, u.staff_id, st.name AS teacher_name,
            u.start_min, u.end_min, u.reason
       FROM ser_occ o
       JOIN unav u ON u.staff_id = o.teacher_id
                  AND u.on_date = ${kstDateOf('lower(o.span)')}
                  AND u.start_min < ${END_MIN}
                  AND u.end_min > ${START_MIN}
       JOIN staff st ON st.id = u.staff_id
      WHERE o.ser_id = ANY($1)
        AND NOT o.canceled
        AND ${kstDateOf('lower(o.span)')} >= (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY 2, u.start_min
      LIMIT 10`,
    [serIds],
  )) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    serId: Number(r.ser_id),
    date: String(r.date),
    teacherId: Number(r.staff_id),
    teacherName: String(r.teacher_name),
    startMin: Number(r.start_min),
    endMin: Number(r.end_min),
    reason: String(r.reason),
  }));
}

@Injectable()
export class ScheduleWriteService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 잠금 후 원래 회차 키를 확인한다. 이동 날짜/취소 여부로 판정하면 복원 가능한 회차도 막힌다. */
  private requireOccurrence(state: State, serId: number, onDate: string) {
    const ser = state.SER.find((s) => s.id === serId);
    if (!ser) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
    if (!ruleHits(ser, onDate)) {
      throw new NotFoundException({
        code: 'OCCURRENCE_NOT_FOUND',
        message: `${onDate} 회차가 없습니다. 최신 목록에서 수업을 다시 선택해 주세요`,
      });
    }
    return ser;
  }

  /** 네 단계를 한 트랜잭션으로 감싸는 자리. 모든 쓰기가 이것을 통과한다. */
  private async tx<T extends WriteResultDto = WriteResultDto>(
    serIds: number[],
    reduce: (before: State, q: QueryRunner) =>
      { after: State; log: string[]; effScope: string } |
      Promise<{ after: State; log: string[]; effScope: string }>,
    enrich?: (q: QueryRunner, fresh: State, base: WriteResultDto) => Promise<T>,
    actorId?: number,
    undoable = true,
    /**
     * 바깥 트랜잭션 안에서 부를 때 (C91 등록 확정 — STU·ENR·SER·INV·ISSUE·GUIDE·NOTI 가 한 트랜잭션).
     * 주어지면 여기서 열지도 닫지도 않는다 — 실패는 그대로 던져 바깥이 통째로 되돌린다.
     */
    outer?: QueryRunner,
  ): Promise<T> {
    if (outer) return this.txBody(outer, serIds, reduce, enrich, actorId, undoable);
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const result = await this.txBody(q, serIds, reduce, enrich, actorId, undoable);
      await q.commitTransaction();
      return result;
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
  }

  private async txBody<T extends WriteResultDto = WriteResultDto>(
    q: QueryRunner,
    serIds: number[],
    reduce: (before: State, q: QueryRunner) =>
      { after: State; log: string[]; effScope: string } |
      Promise<{ after: State; log: string[]; effScope: string }>,
    enrich?: (q: QueryRunner, fresh: State, base: WriteResultDto) => Promise<T>,
    actorId?: number,
    undoable = true,
  ): Promise<T> {
    {
      // D-R43: 같은 SER의 모든 쓰기를 최초 snapshot 전에 직렬화한다. 자식만 바꾸는
      // 명단/회차 예외도 이 잠금을 공유하며 persist/project/commit까지 유지한다.
      const before = await loadState(q, serIds, { forWrite: true });
      const { after, log, effScope } = await reduce(before, q);

      const timeIssue = scheduleTimeIssue(after);
      if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });

      await assertScheduleReferences(q, after);
      /*
       * 월 마감 (C92-d · L-123) — 「마감 후에도 자유롭게 고쳐지면 실패」.
       * 날짜 하나로는 못 막는다: 규칙 전체를 고치면(scope=all · 시각 변경) 투영이 지난 달 회차까지 다시 쓴다.
       * 그래서 마감 달에 놓인 회차·예외의 모양을 persist/project 앞뒤로 찍어 **달라졌으면** 통째로 되돌린다.
       * 새 규칙이 마감 달에 회차를 만드는 것도 같은 비교가 잡는다 (뒤 스냅숏에만 줄이 생긴다).
       */
      const closed = await closedMonths(q);
      const closedBefore = await closedOccSnapshot(q, before.SER.map((row) => row.id), closed);
      const touched = await persist(q, before, after);
      // 새로 생긴 규칙은 persist 가 진짜 id 를 붙여 돌려준다. 그 id 로 다시 읽어야
      // 투영이 임시 id 가 아니라 실제 행을 편다.
      const fresh = await loadState(q, touched);
      const projected = await project(q, fresh, touched, horizon());

      const snapshotIds = [...new Set([...before.SER.map((row) => row.id), ...touched])];
      if (closed.length) {
        const closedAfter = await closedOccSnapshot(q, snapshotIds, closed);
        if (closedAfter !== closedBefore) {
          // 어느 달인지 말한다 — 새 규칙이면 시작일의 달, 아니면 바뀐 회차가 든 첫 마감 달
          const hit = closed.find((m) => closedAfter.includes(`"on_date":"${m}-`) || closedBefore.includes(`"on_date":"${m}-`))
            ?? monthOf(after.SER[0]?.fromDate ?? closed[0]!);
          throw monthClosedError(hit);
        }
      }
      const afterSnapshot = actorId && undoable ? await loadState(q, snapshotIds) : null;

      const base = {
        effScope, log, projected, serIds: touched,
        undoToken: actorId && afterSnapshot ? issueScheduleUndo(actorId, before, afterSnapshot) : null,
        unavailable: await unavailableOverlaps(q, touched),
      };
      const result = enrich ? await enrich(q, fresh, base) : base as T;
      return result;
    }
  }

  async create(dto: OccurrenceCreateDto, actorId?: number, outer?: QueryRunner): Promise<WriteResultDto> {
    if (!isIsoDate(dto.fromDate) || (dto.toDate != null && !isIsoDate(dto.toDate))) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '시작일·종료일은 실제 YYYY-MM-DD 날짜여야 합니다' });
    }
    if (dto.toDate != null && dto.toDate < dto.fromDate) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '종료일이 시작일보다 앞설 수 없습니다' });
    }
    // 쓰기 문법 전체를 확인한 뒤 한 번 정규화한다. 과거 저장값용 관대한 parser에 새 입력을 맡기지 않는다.
    const parsed = parseRuleInput(dto.rrule);
    if (!parsed) {
      throw new BadRequestException({
        code: 'BAD_RRULE',
        message: `읽을 수 없는 반복 규칙입니다: ${dto.rrule} (ONCE | DAILY[/n] | WEEKLY:MO,WE[/n])`,
      });
    }
    const rrule = formatRule(parsed);
    const timeIssue = lessonTimeIssue(dto.startMin, dto.endMin);
    if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });

    return this.tx([], () => {
      const empty: State = { SER: [], SER_STU: [], EXC: [] };
      const a = applyCreate(empty, {
        draft: {
          kind: dto.kindKey, sub: dto.subKey ?? null, mode: dto.mode,
          title: dto.title ?? '', teacherId: dto.teacherId ?? null, roomId: dto.roomId ?? null,
          startMin: dto.startMin, endMin: dto.endMin, rrule,
          date: dto.fromDate, toDate: dto.toDate ?? null,
          students: dto.studentIds ?? [],
        },
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    }, undefined, actorId, true, outer);
  }

  /**
   * Ctrl+드래그와 C/X/V의 단일 저장 경로. 클라이언트가 보낸 표시용 내용을 믿지 않고
   * 원본 참조를 occ()로 다시 풀어 copyMany() → applyPaste() 순서로만 새 SER를 만든다.
   */
  async paste(dto: OccurrencePasteDto, actorId?: number): Promise<WriteResultDto> {
    const sourceIds = [...new Set(dto.sources.map((s) => s.serId))];
    return this.tx(sourceIds, (before) => {
      const seen = new Set<string>();
      const sources = dto.sources.map((ref) => {
        const key = `${ref.serId}|${ref.onDate}`;
        if (seen.has(key)) {
          throw new BadRequestException({ code: 'BAD_PASTE', message: '같은 원본 회차가 두 번 들어 있습니다' });
        }
        seen.add(key);
        const source = occ(ref.date, before).find((o) => o.serId === ref.serId && o.onDate === ref.onDate);
        if (!source) {
          throw new NotFoundException({
            code: 'SOURCE_NOT_FOUND',
            message: `복사 원본 ${ref.serId} (${ref.onDate}) 회차를 찾을 수 없습니다`,
          });
        }
        return source;
      });

      const copied = copyMany(before, sources);
      const issue = pasteIssue(copied, dto.targetDate, dto.targetStartMin, dto.scope as Scope);
      if (issue) throw new BadRequestException({ code: 'BAD_PASTE', message: issue });

      let current = before;
      const log: string[] = [];
      if (dto.cut) {
        for (const source of sources) {
          const deleted = applyDelete(current, {
            serId: source.serId, onDate: source.onDate, scope: 'this',
          });
          current = deleted;
          log.push(...deleted.__log);
        }
      }

      const pasted = applyPaste(current, {
        items: copied,
        targetDate: dto.targetDate,
        targetMin: dto.targetStartMin,
        patch: {
          teacherId: dto.teacherId === undefined ? undefined : dto.teacherId,
          roomId: dto.roomId === undefined ? undefined : dto.roomId,
        },
        scope: dto.scope as Scope,
      });
      return { after: pasted, log: [...log, ...pasted.__log], effScope: pasted.__effScope };
    }, undefined, actorId);
  }

  /** C-7 — 여러 PATCH를 클라이언트에서 반복하지 않고 한 load/reduce/persist/project로 묶는다. */
  async moveMany(dto: OccurrenceMoveDto, actorId?: number): Promise<WriteResultDto> {
    const sourceIds = [...new Set(dto.items.map((x) => x.source.serId))];
    return this.tx(sourceIds, (before) => {
      const refs = new Set<string>();
      const recurringIds = new Set<number>();
      let current = before;
      const log: string[] = [];

      for (const item of dto.items) {
        const ref = item.source;
        const key = `${ref.serId}|${ref.onDate}`;
        if (refs.has(key)) {
          throw new BadRequestException({ code: 'BAD_MOVE', message: '같은 원본 회차가 두 번 들어 있습니다' });
        }
        refs.add(key);
        if (dto.scope !== 'this' && recurringIds.has(ref.serId)) {
          throw new BadRequestException({
            code: 'BAD_MOVE',
            message: '같은 반복 규칙의 여러 회차에는 향후·모두 이동을 동시에 적용할 수 없습니다',
          });
        }
        recurringIds.add(ref.serId);
        const source = occ(ref.date, before).find((o) => o.serId === ref.serId && o.onDate === ref.onDate);
        if (!source) {
          throw new NotFoundException({
            code: 'SOURCE_NOT_FOUND',
            message: `이동 원본 ${ref.serId} (${ref.onDate}) 회차를 찾을 수 없습니다`,
          });
        }
        const timeIssue = lessonTimeIssue(item.startMin, item.endMin);
        if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });
        const moved = applyEdit(current, {
          serId: ref.serId,
          onDate: ref.onDate,
          scope: dto.scope as Scope,
          patch: {
            date: item.date,
            startMin: item.startMin,
            endMin: item.endMin,
            teacherId: item.teacherId === undefined ? undefined : item.teacherId,
            roomId: item.roomId === undefined ? undefined : item.roomId,
            __onDate: ref.onDate,
          },
        });
        current = moved;
        log.push(...moved.__log);
      }
      return { after: current, log, effScope: dto.scope };
    }, undefined, actorId);
  }

  /**
   * @param inside 이 쓰기와 **같은 트랜잭션에서 함께 커밋할 일**.
   *   변경 요청 반영(C42)이 쓴다 — 시간표를 바꾸는 것과 요청을 닫는 것이 나뉘면
   *   「시간표는 바뀌었는데 요청은 아직 대기」가 생기고 다시 누르면 두 번 반영된다.
   *   겹침으로 롤백되면 요청 상태도 함께 되돌아간다.
   */
  async patch(
    serId: number, dto: OccurrencePatchDto, inside?: (q: QueryRunner) => Promise<void>, actorId?: number,
    /** 바깥 트랜잭션 — 강사 교체 마법사(C93)가 여러 규칙을 한 트랜잭션에서 고친다. `create` 의 `outer` 와 같다 */
    outer?: QueryRunner,
  ): Promise<WriteResultDto> {
    return this.tx([serId], (before) => {
      const ser = this.requireOccurrence(before, serId, dto.onDate);
      const patch: OccurrencePatch = { __onDate: dto.onDate };
      if (dto.startMin !== undefined) patch.startMin = dto.startMin;
      if (dto.endMin !== undefined) patch.endMin = dto.endMin;
      if (dto.teacherId !== undefined) patch.teacherId = dto.teacherId;
      if (dto.roomId !== undefined) patch.roomId = dto.roomId;
      if (dto.date !== undefined) patch.date = dto.date;

      if (Object.keys(patch).length === 1) {
        throw new BadRequestException({ code: 'EMPTY_PATCH', message: '바꿀 값을 하나 이상 보내야 합니다' });
      }
      if (dto.scope !== 'this' &&
          (dto.startMin === null || dto.endMin === null || dto.date === null)) {
        throw new BadRequestException({
          code: 'BAD_NULL_SCOPE',
          message: '시간·날짜 예외를 규칙값으로 되돌리는 것은 이번 회차에서만 가능합니다',
        });
      }

      const exc = before.EXC.find((e) => e.serId === serId && e.onDate === dto.onDate);
      const baseStart = dto.scope === 'this' ? (exc?.startMin ?? ser.startMin) : ser.startMin;
      const baseEnd = dto.scope === 'this' ? (exc?.endMin ?? ser.endMin) : ser.endMin;
      const startMin = patch.startMin === undefined ? baseStart : (patch.startMin ?? ser.startMin);
      const endMin = patch.endMin === undefined ? baseEnd : (patch.endMin ?? ser.endMin);
      const timeIssue = lessonTimeIssue(startMin, endMin);
      if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });

      const a = applyEdit(before, {
        serId,
        onDate: dto.onDate,
        scope: dto.scope as Scope,
        patch,
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    }, this.withInside(inside), actorId, true, outer);
  }

  /** `inside` 를 `tx` 의 커밋 직전 자리(enrich)에 끼운다. 결과는 바꾸지 않는다. */
  private withInside(inside?: (q: QueryRunner) => Promise<void>) {
    if (!inside) return undefined;
    return async (q: QueryRunner, _fresh: State, base: WriteResultDto): Promise<WriteResultDto> => {
      await inside(q);
      return base;
    };
  }

  /** @param inside `patch` 와 같다 — 같은 트랜잭션에서 함께 커밋할 일 (C42) */
  async remove(
    serId: number, dto: OccurrenceDeleteDto, inside?: (q: QueryRunner) => Promise<void>, actorId?: number,
  ): Promise<WriteResultDto> {
    // 사유·처리는 휴강(이번만)에만 붙는다. 향후·모두는 수업 종료라 정책이 없다 (C92)
    const cancel = dto.scope === 'this' ? cancelArgs(dto) : undefined;
    if (dto.scope !== 'this' && (dto.cancelKind !== undefined || dto.cancelTreat !== undefined || dto.makeup !== undefined)) {
      throw new BadRequestException({
        code: 'CANCEL_SCOPE', message: '휴강 사유·처리는 이번 회차에만 붙습니다 — 향후·모두는 수업 종료입니다',
      });
    }
    // 보강 이관은 보강 회차가 있어야 성립한다 — 날짜 없는 「보강 이관」은 세지도 않고 잡지도 않은 회차가 된다 (C-34)
    if (cancel?.treat === 'makeup' && !dto.makeup) {
      throw new BadRequestException({ code: 'MAKEUP_REQUIRED', message: '보강 이관은 보강 날짜와 시각이 필요합니다' });
    }
    if (dto.makeup && cancel?.treat !== 'makeup') {
      throw new BadRequestException({ code: 'MAKEUP_NOT_MAKEUP', message: '보강 날짜는 처리가 「보강 이관」일 때만 보냅니다' });
    }
    const makeup = dto.makeup;
    if (makeup) {
      if (!isIsoDate(makeup.date)) throw new BadRequestException({ code: 'BAD_RANGE', message: '보강 날짜는 실제 YYYY-MM-DD 날짜여야 합니다' });
      const timeIssue = lessonTimeIssue(makeup.startMin, makeup.endMin);
      if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });
      if (makeup.date === dto.onDate) {
        throw new BadRequestException({ code: 'MAKEUP_SAME_DAY', message: '보강은 같은 날이 아닙니다 — 시각만 바꾸려면 회차를 옮기세요' });
      }
    }
    const after = cancel
      ? async (q: QueryRunner, fresh: State, base: WriteResultDto): Promise<WriteResultDto> => {
        await notifyCancel(q, actorId, serId, dto.onDate, fresh, cancel.treat, makeup ? { date: makeup.date, startMin: makeup.startMin } : undefined);
        if (inside) await inside(q);
        return base;
      }
      : this.withInside(inside);
    return this.tx([serId], async (before, q) => {
      this.requireOccurrence(before, serId, dto.onDate);
      // ATT를 포함한 이력 원장은 SER_OCC와 달리 재투영해 지울 수 없다. 전 회차 삭제 요청이어도
      // 사실 참조가 하나라도 있으면 SER를 보존하고 기간만 마감해야 감사 근거가 함께 남는다.
      const refs = await q.query(
        `SELECT EXISTS (
           SELECT 1 FROM att WHERE ser_id=$1
           UNION ALL SELECT 1 FROM rep WHERE ser_id=$1
           UNION ALL SELECT 1 FROM autorep WHERE ser_id=$1
           UNION ALL SELECT 1 FROM chreq WHERE ser_id=$1
           UNION ALL SELECT 1 FROM guide WHERE ser_id=$1
           UNION ALL SELECT 1 FROM pnoti WHERE ser_id=$1
           UNION ALL SELECT 1 FROM payout_line WHERE ser_id=$1
           UNION ALL SELECT 1 FROM cons_sess WHERE ser_id=$1
           UNION ALL SELECT 1 FROM note WHERE ser_id=$1
           UNION ALL SELECT 1 FROM diag WHERE ser_id=$1
           UNION ALL SELECT 1 FROM zassign WHERE ser_id=$1
         ) AS has_refs`, [serId],
      ) as Array<{ has_refs: boolean }>;
      const a = applyDelete(before, {
        serId,
        onDate: dto.onDate,
        scope: dto.scope as Scope,
        hasRefs: refs[0]?.has_refs === true,
        cancel,
        makeup: makeup
          ? { date: makeup.date, startMin: makeup.startMin, endMin: makeup.endMin, teacherId: makeup.teacherId, roomId: makeup.roomId }
          : undefined,
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    }, after, actorId, false);
  }

  /**
   * 그날 전체 휴강 (테스트 시나리오 C-33 공휴일 · N-133 태풍·감염병) — 한 트랜잭션이다.
   * 「일부만 처리되면 실패」가 판정이라, 회차 하나가 막히면 전부 되돌아간다.
   * 이미 휴강인 회차는 건너뛰고 세어서 돌려준다 — 두 번 접지 않는다.
   */
  async dayCancel(dto: DayCancelDto, actorId?: number): Promise<DayCancelResultDto> {
    const cancel = cancelArgs(dto);
    if (!cancel) throw new BadRequestException({ code: 'CANCEL_REASON_REQUIRED', message: CANCEL_POLICY_MESSAGE.CANCEL_REASON_REQUIRED });
    // 회차마다 보강 날짜가 다르다 — 그날 전체는 이월(또는 차감)만 받고 보강은 회차의 휴강 창에서 잡는다 (C-33 · C-34)
    if (cancel.treat === 'makeup') {
      throw new BadRequestException({ code: 'MAKEUP_NOT_BULK', message: '그날 전체 휴강은 보강 이관을 받지 않습니다 — 보강은 회차마다 잡습니다' });
    }
    const q0 = this.ds.createQueryRunner();
    await q0.connect();
    let serIds: number[];
    try {
      serIds = ((await q0.query(
        `SELECT DISTINCT ser_id FROM ser_occ WHERE ${kstDateOf('lower(span)')} = $1::date ORDER BY ser_id`, [dto.date],
      )) as Array<{ ser_id: string }>).map((r) => Number(r.ser_id));
    } finally { await q0.release(); }
    if (!serIds.length) {
      throw new NotFoundException({ code: 'NO_OCCURRENCES', message: `${dto.date} 에는 회차가 없습니다` });
    }
    let count = 0;
    let skipped = 0;
    const targets: Array<{ serId: number; onDate: string }> = [];
    return this.tx<DayCancelResultDto>(serIds, (before) => {
      let current = before;
      const log: string[] = [];
      // occ() 는 표시용이라 휴강을 그리지 않는다 — 이미 접힌 회차는 투영(project)과 같은 판정으로 센다:
      // 규칙에 맞는 날인데 그 날짜의 EXC 가 취소인 것
      skipped = before.SER.filter((s) => ruleHits(s, dto.date)
        && before.EXC.some((e) => e.serId === s.id && e.onDate === dto.date && e.canceled)).length;
      for (const o of occ(dto.date, before)) {
        if (o.canceled) { skipped += 1; continue; }
        const a = applyDelete(current, { serId: o.serId, onDate: o.onDate, scope: 'this', cancel });
        current = a;
        log.push(...a.__log);
        targets.push({ serId: o.serId, onDate: o.onDate });
        count += 1;
      }
      return { after: current, log, effScope: 'this' };
    }, async (q, fresh, base) => {
      for (const t of targets) await notifyCancel(q, actorId, t.serId, t.onDate, fresh, cancel.treat);
      return { ...base, count, skipped };
    }, actorId, false);
  }

  /** §12 · §79 — 학생 넣고 빼기. 「그날만 빼기」가 D-R21 이다. */
  async roster(serId: number, dto: RosterPatchDto, actorId?: number): Promise<RosterResultDto> {
    return this.tx<RosterResultDto>([serId], async (before, q) => {
      this.requireOccurrence(before, serId, dto.onDate);
      const student = await q.query('SELECT id FROM stu WHERE id=$1', [dto.studentId]) as Array<{ id: string }>;
      if (!student.length) {
        throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: `학생 ${dto.studentId} 이(가) 없습니다` });
      }
      const allowed = rosterScopes(before, serId, dto.studentId, dto.onDate);
      if (!allowed.includes(dto.op)) {
        throw new BadRequestException({
          code: 'BAD_ROSTER_OP',
          message: `현재 명단에는 ${dto.op} 작업을 적용할 수 없습니다`,
        });
      }
      const a = applyRoster(before, {
        serId, onDate: dto.onDate, studentId: dto.studentId, op: dto.op,
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    }, async (q, fresh, base) => {
      const ids = rosterAt(fresh, serId, dto.onDate);
      const meta = await q.query(
        `SELECT k.cap, s.kind_key, s.sub_key
           FROM ser s JOIN kind k ON k.key=s.kind_key
          WHERE s.id=$1`,
        [serId],
      ) as Array<{ cap: number; kind_key: string; sub_key: string | null }>;
      if (!meta.length) {
        throw new BadRequestException({ code: 'KIND_NOT_FOUND', message: '수업 종류와 정원을 찾을 수 없습니다' });
      }
      const rows = await q.query(
        `SELECT st.name,
                NOT EXISTS (
                  SELECT 1 FROM guide g
                   WHERE g.ser_id=$1 AND g.student_id=st.id
                     AND g.state::text = ANY($3::text[])
                ) AS need_guide,
                NOT EXISTS (
                  SELECT 1 FROM issue i JOIN lib l ON l.id=i.lib_id
                   WHERE i.student_id=st.id AND i.state='ok'
                     AND (s.sub_key IS NULL OR l.sub_key IS NULL OR l.sub_key=s.sub_key)
                ) AS need_book
           FROM stu st CROSS JOIN ser s
          WHERE s.id=$1 AND st.id = ANY($2::bigint[])
          ORDER BY st.name`,
        [serId, ids, [...GUIDE_DONE_DB]],
      ) as Array<{ name: string; need_guide: boolean; need_book: boolean }>;
      if (rows.length !== ids.length) {
        throw new BadRequestException({ code: 'INVALID_ROSTER', message: '명단에 존재하지 않는 학생이 있습니다' });
      }
      // N-17 (§4-17 ①): 명단 변경 직후 가격 재계산 (D-R22). 산식은 lib/rules 한 곳 — 화면은 값만 그린다.
      const tiers = await q.query(
        `SELECT DISTINCT ON (heads) heads, unit_price
           FROM rate
          WHERE kind_key = $1 AND sub_key IS NOT DISTINCT FROM $2 AND from_date <= $3
          ORDER BY heads, from_date DESC, id DESC`,
        [meta[0].kind_key, meta[0].sub_key, dto.onDate],
      ) as Array<{ heads: number; unit_price: number }>;
      const overrides = ids.length ? await q.query(
        `SELECT DISTINCT ON (st.id) st.id, r.unit_price
           FROM stu st
           LEFT JOIN sturate r
             ON r.student_id = st.id AND (r.kind_key IS NULL OR r.kind_key = $2) AND r.from_date <= $3
          WHERE st.id = ANY($1::bigint[])
          ORDER BY st.id, r.from_date DESC NULLS LAST, r.id DESC`,
        [ids, meta[0].kind_key, dto.onDate],
      ) as Array<{ id: string; unit_price: number | null }> : [];
      const pricing = rosterPricing(
        tiers.map((r) => ({ heads: Number(r.heads), unitPrice: Number(r.unit_price) })),
        overrides.map((r) => (r.unit_price === null || r.unit_price === undefined ? null : Number(r.unit_price))),
      );
      return {
        ...base,
        count: ids.length,
        cap: Number(meta[0].cap),
        needGuide: rows.filter((r) => r.need_guide).map((r) => r.name),
        needBook: rows.filter((r) => r.need_book).map((r) => r.name),
        priced: pricing !== null,
        unitPrice: pricing ? pricing.unitPrice : null,
        total: pricing ? pricing.total : null,
        tierHeads: pricing ? pricing.tierHeads : null,
        overrideCount: pricing ? pricing.overrideCount : 0,
      };
    }, actorId);
  }

  /**
   * Ctrl/⌘+Z — 토큰이 가리키는 행만 잠그고, 발급 직후 상태와 현재 상태가 같을 때만 복원한다.
   * 화면 캐시를 되감는 기능이 아니다. DB 복원과 재투영이 한 트랜잭션으로 끝나야 한다.
   */
  async undo(actorId: number, token: string): Promise<WriteResultDto> {
    const payload = readScheduleUndo(token, actorId);
    if (!payload) {
      throw new BadRequestException({ code: 'BAD_UNDO_TOKEN', message: '되돌리기 시간이 지났거나 토큰이 올바르지 않습니다' });
    }
    const ids = [...new Set([...payload.before.SER, ...payload.after.SER].map((row) => row.id))];
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const current = await loadState(q, ids, { forWrite: true });
      if (!sameScheduleState(current, payload.after)) {
        throw new ConflictException({
          code: 'UNDO_STALE',
          message: '그 뒤 같은 수업이 다시 바뀌어 이전 작업을 안전하게 되돌릴 수 없습니다',
        });
      }
      const timeIssue = scheduleTimeIssue(payload.before);
      if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });
      await assertScheduleReferences(q, payload.before);
      const touched = await persist(q, current, payload.before);
      const fresh = await loadState(q, touched);
      const projected = await project(q, fresh, touched, horizon());
      const result: WriteResultDto = {
        effScope: 'undo',
        log: ['직전 일정 쓰기를 되돌렸습니다'],
        projected,
        serIds: touched,
        undoToken: null,
        unavailable: await unavailableOverlaps(q, touched),
      };
      await q.commitTransaction();
      return result;
    } catch (error) {
      await q.rollbackTransaction();
      throw error;
    } finally {
      await q.release();
    }
  }
}
