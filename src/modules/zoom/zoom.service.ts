/** @file-guide
 * 목적: zoom.service.ts — ZoomService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryRunner, Repository } from 'typeorm';
import { Zacc } from '../../entities';
import { nowHourKst, todayKst } from '../../lib/kst';
import { sealSecret, secretKeyFrom } from '../../lib/secret-box';
import { loadState } from '../schedule/schedule.state.repo';
import { project } from '../schedule/schedule.project';
import type {
  ZoomAccountCreateDto, ZoomAcctDto, ZoomAccountPatchDto, ZoomAssignDto, ZoomAssignResultDto, ZoomBoardDto,
} from './zoom.dto';

/** §21 격자가 보여 주는 시간 — 원본이 08~21 이다. 화면이 아니라 서버가 범위를 말한다 */
const FROM_HOUR = 8;
const TO_HOUR = 21;

@Injectable()
export class ZoomService {
  constructor(
    @InjectRepository(Zacc) private readonly zaccs: Repository<Zacc>,
    private readonly cfg: ConfigService,
  ) {}

  private key(): Buffer {
    const key = secretKeyFrom(this.cfg.get<string>('ZOOM_ENC_KEY'));
    if (!key) {
      throw new BadRequestException({
        code: 'ZOOM_ENC_KEY_MISSING',
        message: '줌 비밀을 저장할 키(ZOOM_ENC_KEY)가 없습니다 — 평문으로 저장하지 않습니다',
      });
    }
    return key;
  }

  /**
   * §21 격자 — 계정 × 시간. **점유는 `ser_occ` 에서 센다**(투영이 정본이고 EXCLUDE 가 지킨다).
   * 「지금 가능」과 「만석 시간대」도 같은 배열에서 센다 — 두 곳에서 세지 않는다 (C40 의 교훈).
   */
  async board(onDate?: string): Promise<ZoomBoardDto> {
    const date = onDate ?? todayKst();
    const accounts = (await this.zaccs.query(
      `SELECT z.id, z.label, z.login_email, z.join_url, z.meeting_id, z.active,
              (z.login_secret IS NOT NULL AND octet_length(z.login_secret) > 0) AS has_secret,
              (SELECT count(*)::int FROM ser_occ o
                WHERE o.zacc_id = z.id AND NOT o.canceled
                  AND (lower(o.span) AT TIME ZONE 'Asia/Seoul')::date = $1::date) AS used
         FROM zacc z ORDER BY z.active DESC, z.id`,
      [date],
    )) as Array<Record<string, unknown>>;

    const busy = (await this.zaccs.query(
      `SELECT o.zacc_id,
              EXTRACT(HOUR FROM lower(o.span) AT TIME ZONE 'Asia/Seoul')::int AS h,
              count(*)::int AS n
         FROM ser_occ o
        WHERE o.zacc_id IS NOT NULL AND NOT o.canceled
          AND (lower(o.span) AT TIME ZONE 'Asia/Seoul')::date = $1::date
        GROUP BY 1, 2`,
      [date],
    )) as Array<{ zacc_id: string; h: number; n: number }>;

    const hours = Array.from({ length: TO_HOUR - FROM_HOUR + 1 }, (_, i) => FROM_HOUR + i);
    const at = new Map(busy.map((b) => [`${b.zacc_id}|${b.h}`, Number(b.n)]));
    const live = accounts.filter((a) => a.active === true);
    const rows = live.map((a) => ({
      zaccId: Number(a.id), label: String(a.label),
      slots: hours.map((hour) => ({ hour, busy: at.get(`${a.id}|${hour}`) ?? 0 })),
    }));

    /*
     * 「지금 가능」은 **그 시각에** 비었는가다 — 하루 내내 비었는가가 아니다.
     * 원문 §21 은 다섯 계정 모두 낮에 붉은 칸이 있는데도 「지금 가능 5」라고 적는다.
     * 하루 기준으로 세면 그 화면은 0 이 된다. 오늘이 아니면 「지금」이 없으므로 null 이다.
     *
     * 시각 밖(새벽 3시 같은)이라도 옳게 센다 — 점유 질의에 시(hour) 제한이 없어
     * 격자에 안 그리는 시간도 `at` 에 들어 있다.
     */
    const nowHour = date === todayKst() ? nowHourKst() : null;
    // 수와 이름을 **한 배열에서** 낸다. 따로 세면 「5개」인데 이름은 넷인 화면이 생긴다 (D-R37)
    const freeRows = nowHour === null ? [] : rows.filter((r) => (at.get(`${r.zaccId}|${nowHour}`) ?? 0) === 0);

    return {
      onDate: date, fromHour: FROM_HOUR, toHour: TO_HOUR,
      accounts: accounts.map((a) => this.row(a)),
      rows,
      nowHour,
      freeNow: freeRows.length,
      freeLabels: freeRows.map((r) => r.label),
      fullHours: hours.filter((h) => rows.length > 0 && rows.every((r) => (at.get(`${r.zaccId}|${h}`) ?? 0) > 0)).length,
    };
  }

  private row(r: Record<string, unknown>): ZoomAcctDto {
    return {
      id: Number(r.id), label: String(r.label), loginEmail: String(r.login_email),
      joinUrl: String(r.join_url), meetingId: (r.meeting_id as string | null) ?? null,
      active: r.active === true, usedCount: Number(r.used ?? 0), hasSecret: r.has_secret === true,
    };
  }

  async create(userId: number, dto: ZoomAccountCreateDto): Promise<ZoomAcctDto> {
    const key = this.key();
    return this.zaccs.manager.transaction(async (m: EntityManager) => {
      const [dup] = (await m.query(`SELECT id FROM zacc WHERE label = $1`, [dto.label.trim()])) as { id: string }[];
      if (dup) throw new ConflictException({ code: 'ZACC_LABEL_TAKEN', message: `「${dto.label}」는 이미 있는 이름입니다` });
      const [row] = (await m.query(
        `INSERT INTO zacc (label, login_email, login_secret, join_url, meeting_id, meeting_pw_enc, active)
         VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
        [
          dto.label.trim(), dto.loginEmail.trim(),
          sealSecret(dto.loginSecret ?? '', key), dto.joinUrl.trim(),
          dto.meetingId?.trim() || null,
          dto.meetingPw ? sealSecret(dto.meetingPw, key) : null,
        ],
      )) as { id: string }[];
      await m.query(`INSERT INTO zlog (zacc_id, actor_id, action) VALUES ($1,$2,'rotate')`, [Number(row.id), userId]);
      const [out] = (await m.query(
        `SELECT id,label,login_email,join_url,meeting_id,active,
                (login_secret IS NOT NULL AND octet_length(login_secret) > 0) AS has_secret, 0 AS used
           FROM zacc WHERE id = $1`, [Number(row.id)],
      )) as Array<Record<string, unknown>>;
      return this.row(out);
    });
  }

  async patch(userId: number, id: number, dto: ZoomAccountPatchDto): Promise<ZoomAcctDto> {
    return this.zaccs.manager.transaction(async (m: EntityManager) => {
      const [cur] = (await m.query(`SELECT id FROM zacc WHERE id = $1 FOR UPDATE`, [id])) as { id: string }[];
      if (!cur) throw new NotFoundException({ code: 'ZACC_NOT_FOUND', message: '줌 계정을 찾을 수 없습니다' });
      const set: string[] = [];
      const vals: unknown[] = [id];
      const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (dto.label !== undefined) put('label', dto.label.trim());
      if (dto.loginEmail !== undefined) put('login_email', dto.loginEmail.trim());
      if (dto.joinUrl !== undefined) put('join_url', dto.joinUrl.trim());
      if (dto.meetingId !== undefined) put('meeting_id', dto.meetingId.trim() || null);
      if (dto.active !== undefined) put('active', dto.active);
      if (dto.loginSecret !== undefined) put('login_secret', sealSecret(dto.loginSecret, this.key()));
      if (dto.meetingPw !== undefined) put('meeting_pw_enc', sealSecret(dto.meetingPw, this.key()));
      if (!set.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: '바꿀 값이 없습니다' });
      await m.query(`UPDATE zacc SET ${set.join(', ')} WHERE id = $1`, vals);
      if (dto.loginSecret !== undefined || dto.meetingPw !== undefined) {
        await m.query(`INSERT INTO zlog (zacc_id, actor_id, action) VALUES ($1,$2,'rotate')`, [id, userId]);
      }
      const [out] = (await m.query(
        `SELECT id,label,login_email,join_url,meeting_id,active,
                (login_secret IS NOT NULL AND octet_length(login_secret) > 0) AS has_secret,
                (SELECT count(*)::int FROM ser_occ o WHERE o.zacc_id = zacc.id AND NOT o.canceled) AS used
           FROM zacc WHERE id = $1`, [id],
      )) as Array<Record<string, unknown>>;
      return this.row(out);
    });
  }

  /**
   * 배정 — 정본은 `zassign` 이고 `ser_occ.zacc_id` 는 투영이다.
   *
   * 회차 하나만 바꾸면 그 날짜의 **EXC 에** 붙인다. EXC 가 없으면 만든다 — 「이 회차는 다르다」가
   * 곧 EXC 이므로, 줌만 다른 경우에도 같은 길을 탄다 (규칙을 두 벌 만들지 않는다).
   * 겹침은 마지막에 `ser_occ` 의 EXCLUDE 가 막고, 그때 트랜잭션이 통째로 되돌아간다.
   */
  async assign(userId: number, dto: ZoomAssignDto): Promise<ZoomAssignResultDto> {
    return this.zaccs.manager.transaction((m) => this.assignIn(m, userId, dto));
  }

  /**
   * 같은 일을 **남의 트랜잭션 안에서** 한다 — 변경 요청 반영이 이 길로 들어온다 (§20 줌 갈래).
   * 배정과 요청 종결이 한 트랜잭션이라, 겹쳐서 막히면 요청도 pending 으로 되돌아간다 (C42 의 규칙).
   */
  async assignIn(m: EntityManager, userId: number, dto: ZoomAssignDto): Promise<ZoomAssignResultDto> {
    const zaccId = dto.zaccId ?? null;
    {
      const q = m.queryRunner as QueryRunner;
      const [ser] = (await m.query(`SELECT id FROM ser WHERE id = $1`, [dto.serId])) as { id: string }[];
      if (!ser) throw new NotFoundException({ code: 'SER_NOT_FOUND', message: '수업 규칙을 찾을 수 없습니다' });
      if (zaccId !== null) {
        const [z] = (await m.query(`SELECT id, active FROM zacc WHERE id = $1`, [zaccId])) as { id: string; active: boolean }[];
        if (!z) throw new NotFoundException({ code: 'ZACC_NOT_FOUND', message: '줌 계정을 찾을 수 없습니다' });
        if (!z.active) throw new ConflictException({ code: 'ZACC_INACTIVE', message: '꺼 둔 계정은 새로 배정할 수 없습니다' });
      }

      let excId: number | null = null;
      if (dto.onDate) {
        const [exc] = (await m.query(
          `SELECT id FROM exc WHERE ser_id = $1 AND on_date = $2::date`, [dto.serId, dto.onDate],
        )) as { id: string }[];
        if (exc) excId = Number(exc.id);
        else {
          const [made] = (await m.query(
            `INSERT INTO exc (ser_id, on_date, canceled, reason, by_id) VALUES ($1,$2::date,false,$3,$4) RETURNING id`,
            [dto.serId, dto.onDate, '줌 계정 배정', userId],
          )) as { id: string }[];
          excId = Number(made.id);
        }
        await m.query(`DELETE FROM zassign WHERE exc_id = $1`, [excId]);
        if (zaccId !== null) {
          await m.query(`INSERT INTO zassign (exc_id, zacc_id, fixed) VALUES ($1,$2,false)`, [excId, zaccId]);
        }
      } else {
        await m.query(`DELETE FROM zassign WHERE ser_id = $1`, [dto.serId]);
        if (zaccId !== null) {
          await m.query(`INSERT INTO zassign (ser_id, zacc_id, fixed) VALUES ($1,$2,true)`, [dto.serId, zaccId]);
        }
      }
      if (zaccId !== null) {
        await m.query(`INSERT INTO zlog (zacc_id, actor_id, action) VALUES ($1,$2,'assign')`, [zaccId, userId]);
      }

      // 겹침 판정이 되돌아갈 수 있게 규칙을 먼저 잠근다 (다른 쓰기 경로와 같은 순서)
      const state = await loadState(q, [dto.serId], { forWrite: true });
      const projected = await project(q, state, [dto.serId]);
      return { serId: dto.serId, onDate: dto.onDate ?? null, zaccId, projected };
    }
  }
}
