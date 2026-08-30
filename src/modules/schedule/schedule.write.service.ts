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
import { DataSource } from 'typeorm';
import {
  applyCreate, applyDelete, applyEdit, applyRoster, formatRule, parseRule,
  type Scope, type State,
} from '../../lib/recurrence';
import { loadState, persist } from './schedule.state.repo';
import { horizon, project } from './schedule.project';
import type {
  OccurrenceCreateDto, OccurrenceDeleteDto, OccurrencePatchDto, RosterPatchDto, WriteResultDto,
} from './schedule.dto';

@Injectable()
export class ScheduleWriteService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 네 단계를 한 트랜잭션으로 감싸는 자리. 모든 쓰기가 이것을 통과한다. */
  private async tx(
    serIds: number[],
    reduce: (before: State) => { after: State; log: string[]; effScope: string },
  ): Promise<WriteResultDto> {
    const q = this.ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const before = await loadState(q, serIds);
      const { after, log, effScope } = reduce(before);

      const touched = await persist(q, before, after);
      // 새로 생긴 규칙은 persist 가 진짜 id 를 붙여 돌려준다. 그 id 로 다시 읽어야
      // 투영이 임시 id 가 아니라 실제 행을 편다.
      const fresh = await loadState(q, touched);
      const projected = await project(q, fresh, touched, horizon());

      await q.commitTransaction();
      return { effScope, log, projected, serIds: touched };
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
    if (dto.endMin <= dto.startMin) {
      throw new BadRequestException({ code: 'BAD_RANGE', message: '끝나는 시각이 시작보다 앞입니다' });
    }

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

  async patch(serId: number, dto: OccurrencePatchDto): Promise<WriteResultDto> {
    return this.tx([serId], (before) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
      const a = applyEdit(before, {
        serId,
        onDate: dto.onDate,
        scope: dto.scope as Scope,
        patch: {
          startMin: dto.startMin ?? undefined,
          endMin: dto.endMin ?? undefined,
          teacherId: dto.teacherId ?? undefined,
          roomId: dto.roomId ?? undefined,
          date: dto.date ?? undefined,
          __onDate: dto.onDate,
        },
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    });
  }

  async remove(serId: number, dto: OccurrenceDeleteDto): Promise<WriteResultDto> {
    return this.tx([serId], (before) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
      const a = applyDelete(before, { serId, onDate: dto.onDate, scope: dto.scope as Scope });
      return { after: a, log: a.__log, effScope: a.__effScope };
    });
  }

  /** §12 · §79 — 학생 넣고 빼기. 「그날만 빼기」가 D-R21 이다. */
  async roster(serId: number, dto: RosterPatchDto): Promise<WriteResultDto> {
    return this.tx([serId], (before) => {
      if (!before.SER.length) throw new NotFoundException({ code: 'NOT_FOUND', message: `수업 ${serId} 이(가) 없습니다` });
      const a = applyRoster(before, {
        serId, onDate: dto.onDate, studentId: dto.studentId, op: dto.op,
      });
      return { after: a, log: a.__log, effScope: a.__effScope };
    });
  }
}
