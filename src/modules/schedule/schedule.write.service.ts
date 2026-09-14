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
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  applyCreate, applyDelete, applyEdit, applyPaste, applyRoster, copyMany, formatRule, occ,
  lessonTimeIssue, parseRuleInput, pasteIssue, rosterAt, rosterScopes, ruleHits, scheduleTimeIssue,
  type Patch as OccurrencePatch, type Scope, type State,
} from '../../lib/recurrence';
import { rosterPricing, GUIDE_DONE_DB } from '../../lib/rules';
import { isIsoDate } from '../../lib/kst';
import { START_MIN, END_MIN, kstDateOf } from '../../lib/sql';
import { loadState, persist } from './schedule.state.repo';
import { assertScheduleReferences } from './schedule.references';
import { horizon, project } from './schedule.project';
import type {
  OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceMoveDto, OccurrencePasteDto, OccurrencePatchDto,
  RosterPatchDto, RosterResultDto, UnavWarnDto, WriteResultDto,
} from './schedule.dto';

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
  ): Promise<T> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      // D-R43: 같은 SER의 모든 쓰기를 최초 snapshot 전에 직렬화한다. 자식만 바꾸는
      // 명단/회차 예외도 이 잠금을 공유하며 persist/project/commit까지 유지한다.
      const before = await loadState(q, serIds, { forWrite: true });
      const { after, log, effScope } = await reduce(before, q);

      const timeIssue = scheduleTimeIssue(after);
      if (timeIssue) throw new BadRequestException({ code: 'BAD_RANGE', message: timeIssue });

      await assertScheduleReferences(q, after);
      const touched = await persist(q, before, after);
      // 새로 생긴 규칙은 persist 가 진짜 id 를 붙여 돌려준다. 그 id 로 다시 읽어야
      // 투영이 임시 id 가 아니라 실제 행을 편다.
      const fresh = await loadState(q, touched);
      const projected = await project(q, fresh, touched, horizon());

      const base = {
        effScope, log, projected, serIds: touched,
        unavailable: await unavailableOverlaps(q, touched),
      };
      const result = enrich ? await enrich(q, fresh, base) : base as T;
      await q.commitTransaction();
      return result;
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
  }

  async create(dto: OccurrenceCreateDto): Promise<WriteResultDto> {
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
    });
  }

  /**
   * Ctrl+드래그와 C/X/V의 단일 저장 경로. 클라이언트가 보낸 표시용 내용을 믿지 않고
   * 원본 참조를 occ()로 다시 풀어 copyMany() → applyPaste() 순서로만 새 SER를 만든다.
   */
  async paste(dto: OccurrencePasteDto): Promise<WriteResultDto> {
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
    });
  }

  /** C-7 — 여러 PATCH를 클라이언트에서 반복하지 않고 한 load/reduce/persist/project로 묶는다. */
  async moveMany(dto: OccurrenceMoveDto): Promise<WriteResultDto> {
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
    });
  }

  /**
   * @param inside 이 쓰기와 **같은 트랜잭션에서 함께 커밋할 일**.
   *   변경 요청 반영(C42)이 쓴다 — 시간표를 바꾸는 것과 요청을 닫는 것이 나뉘면
   *   「시간표는 바뀌었는데 요청은 아직 대기」가 생기고 다시 누르면 두 번 반영된다.
   *   겹침으로 롤백되면 요청 상태도 함께 되돌아간다.
   */
  async patch(
    serId: number, dto: OccurrencePatchDto, inside?: (q: QueryRunner) => Promise<void>,
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
    }, this.withInside(inside));
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
    serId: number, dto: OccurrenceDeleteDto, inside?: (q: QueryRunner) => Promise<void>,
  ): Promise<WriteResultDto> {
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
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    }, this.withInside(inside));
  }

  /** §12 · §79 — 학생 넣고 빼기. 「그날만 빼기」가 D-R21 이다. */
  async roster(serId: number, dto: RosterPatchDto): Promise<RosterResultDto> {
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
    });
  }
}
