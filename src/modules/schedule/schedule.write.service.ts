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
  lessonTimeIssue, parseRule, pasteIssue, rosterAt, rosterScopes, ruleHits,
  type Patch as OccurrencePatch, type Scope, type State,
} from '../../lib/recurrence';
import { GUIDE_DONE_DB } from '../../lib/rules';
import { loadState, persist } from './schedule.state.repo';
import { horizon, project } from './schedule.project';
import type {
  OccurrenceCreateDto, OccurrenceDeleteDto, OccurrenceMoveDto, OccurrencePasteDto, OccurrencePatchDto,
  RosterPatchDto, RosterResultDto, WriteResultDto,
} from './schedule.dto';

@Injectable()
export class ScheduleWriteService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

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
      const before = await loadState(q, serIds);
      const { after, log, effScope } = await reduce(before, q);

      const touched = await persist(q, before, after);
      // 새로 생긴 규칙은 persist 가 진짜 id 를 붙여 돌려준다. 그 id 로 다시 읽어야
      // 투영이 임시 id 가 아니라 실제 행을 편다.
      const fresh = await loadState(q, touched);
      const projected = await project(q, fresh, touched, horizon());

      const base = { effScope, log, projected, serIds: touched };
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
    // 형식을 여기서 한 번 정규화한다 — 다른 형식이 들어오면 규칙이 어떤 날짜에도 안 맞는다
    const parsed = parseRule(dto.rrule);
    const rrule = formatRule(parsed);
    // WEEKLY 인데 요일이 하나도 안 잡혔다 = 읽지 못한 형식이다.
    // 그대로 두면 어떤 날짜에도 안 맞아 회차가 0개인 수업이 조용히 생긴다.
    if (parsed.freq === 'WEEKLY' && parsed.days.length === 0) {
      throw new BadRequestException({
        code: 'BAD_RRULE',
        message: `읽을 수 없는 반복 규칙입니다: ${dto.rrule} (ONCE | DAILY[/n] | WEEKLY:MO,WE[/n])`,
      });
    }
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

  async patch(serId: number, dto: OccurrencePatchDto): Promise<WriteResultDto> {
    return this.tx([serId], (before) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
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

      const ser = before.SER[0];
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
    });
  }

  async remove(serId: number, dto: OccurrenceDeleteDto): Promise<WriteResultDto> {
    return this.tx([serId], async (before, q) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
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
    });
  }

  /** §12 · §79 — 학생 넣고 빼기. 「그날만 빼기」가 D-R21 이다. */
  async roster(serId: number, dto: RosterPatchDto): Promise<RosterResultDto> {
    return this.tx<RosterResultDto>([serId], async (before, q) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
      const student = await q.query('SELECT id FROM stu WHERE id=$1', [dto.studentId]) as Array<{ id: string }>;
      if (!student.length) {
        throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: `학생 ${dto.studentId} 이(가) 없습니다` });
      }
      const ser = before.SER[0];
      if (!ruleHits(ser, dto.onDate)) {
        throw new NotFoundException({ code: 'OCCURRENCE_NOT_FOUND', message: `${dto.onDate} 회차가 없습니다` });
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
        `SELECT k.cap
           FROM ser s JOIN kind k ON k.key=s.kind_key
          WHERE s.id=$1`,
        [serId],
      ) as Array<{ cap: number }>;
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
                   WHERE i.student_id=st.id AND i.returned_on IS NULL
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
      return {
        ...base,
        count: ids.length,
        cap: Number(meta[0].cap),
        needGuide: rows.filter((r) => r.need_guide).map((r) => r.name),
        needBook: rows.filter((r) => r.need_book).map((r) => r.name),
      };
    });
  }
}
