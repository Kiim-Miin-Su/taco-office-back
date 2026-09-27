/** @file-guide
 * 목적: catalog.service.ts — CatalogService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Kind } from '../../entities';
import { audit } from '../../lib/audit';
import {
  KIND_GROUP_LABEL, type CatalogDto, type KindCreateDto, type KindPatchDto, type KindRowsDto,
  type SubCreateDto, type SubPatchDto, type SubRowDto,
} from './catalog.dto';

@Injectable()
export class CatalogService {
  constructor(@InjectRepository(Kind) private readonly kinds: Repository<Kind>) {}

  /**
   * §18 이 읽는 것과 **같은 두 표**를 쓰기용으로 한 번 더 보여 준다.
   * 다른 점은 「몇 개가 이 낱말을 쓰고 있는가」다 — 코드를 못 바꾸는 이유를 화면이 말할 수 있어야 한다.
   */
  async all(): Promise<CatalogDto> {
    const kinds = (await this.kinds.query(
      `SELECT k.key, k.name, k.color, k.cap, k.grp, k.rep, k.rep_form, k.sort, k.extra,
              (SELECT count(*)::int FROM ser s WHERE s.kind_key = k.key) AS ser_count
         FROM kind k ORDER BY k.sort NULLS LAST, k.key`,
    )) as Array<Record<string, unknown>>;
    const subs = (await this.kinds.query(
      `SELECT b.key, b.name, b.color, b.active, b.sort,
              (SELECT count(*)::int FROM ser s WHERE s.sub_key = b.key) AS ser_count
         FROM sub b ORDER BY b.sort NULLS LAST, b.key`,
    )) as Array<Record<string, unknown>>;
    return {
      kinds: kinds.map((r) => this.kindRow(r)),
      subs: subs.map((r) => this.subRow(r)),
    };
  }

  private kindRow(r: Record<string, unknown>): KindRowsDto {
    const grp = String(r.grp);
    return {
      key: String(r.key), name: String(r.name), color: String(r.color).trim(),
      cap: Number(r.cap), grp, grpLabel: KIND_GROUP_LABEL[grp] ?? grp,
      rep: r.rep === true, repForm: (r.rep_form as string | null) ?? null,
      sort: r.sort === null || r.sort === undefined ? null : Number(r.sort),
      extra: r.extra === true,
      serCount: Number(r.ser_count ?? 0),
    };
  }

  private subRow(r: Record<string, unknown>): SubRowDto {
    return {
      key: String(r.key), name: String(r.name), color: String(r.color).trim(),
      active: r.active === true,
      sort: r.sort === null || r.sort === undefined ? null : Number(r.sort),
      serCount: Number(r.ser_count ?? 0),
    };
  }

  /*
   * N-73 채택(W11) — 만들기 · 고치기 · 끄기는 같은 트랜잭션에 감사 한 줄이다(catalog.kind · catalog.sub).
   * 이 낱말 · 색 · 정원은 시간표 · 범례 · 현황판 · 청구가 함께 쓴다(슬라이드 18 연동) — 누가 언제 무엇을 바꿨는지 남긴다.
   *
   * KIND · SUB 는 **문자 키**다. `log.entity_id` 는 bigint 라 키를 담을 수 없어 0 으로 두고 키를 before · after 의
   * 첫 칸(`key`)에 싣는다 — 읽는 쪽은 `entity='KIND' AND after->>'key'` 로 찾는다(숫자로 바꿔 지어내지 않는다).
   * 고치기는 **보낸 칸만** 앞뒤를 적는다(PATCH 규약) — 안 보낸 칸까지 적으면 안 바뀐 값이 바뀐 것처럼 읽힌다.
   */
  private static readonly KEYED_ENTITY_ID = 0;

  async createKind(actorId: number, dto: KindCreateDto): Promise<KindRowsDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [dup] = (await m.query(`SELECT key FROM kind WHERE key = $1`, [dto.key])) as { key: string }[];
      if (dup) throw new ConflictException({ code: 'KIND_KEY_TAKEN', message: `「${dto.key}」는 이미 있는 코드입니다` });
      // 리포트 대상이면 서식이 있어야 한다 — 서식 없이 「리포트」만 켜면 쓸 화면이 없다
      if (dto.rep && !dto.repForm) {
        throw new BadRequestException({ code: 'REP_FORM_REQUIRED', message: '리포트 대상이면 서식을 골라 주세요' });
      }
      await m.query(
        `INSERT INTO kind (key,name,color,cap,grp,rep,rep_form,sort,extra) VALUES ($1,$2,$3,$4,$5::kind_grp_t,$6,$7,$8,$9)`,
        [dto.key, dto.name.trim(), dto.color, dto.cap, dto.grp, dto.rep === true, dto.rep ? dto.repForm : null, dto.sort ?? null, dto.extra === true],
      );
      const made = await this.one(m, dto.key);
      await audit(m, 'catalog.kind', {
        actorId, entityId: CatalogService.KEYED_ENTITY_ID, action: 'create',
        after: {
          key: made.key, name: made.name, color: made.color, cap: made.cap, grp: made.grp,
          rep: made.rep, repForm: made.repForm ?? null, sort: made.sort ?? null, extra: made.extra,
        },
      });
      return made;
    });
  }

  async patchKind(actorId: number, key: string, dto: KindPatchDto): Promise<KindRowsDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [cur] = (await m.query(
        `SELECT key, name, color, cap, grp::text AS grp, rep, rep_form, sort, extra FROM kind WHERE key = $1 FOR UPDATE`, [key],
      )) as Array<{ key: string; name: string; color: string; cap: number; grp: string; rep: boolean; rep_form: string | null; sort: number | null; extra: boolean }>;
      if (!cur) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '프로그램을 찾을 수 없습니다' });
      const rep = dto.rep ?? cur.rep;
      const repForm = dto.repForm !== undefined ? dto.repForm : cur.rep_form;
      if (rep && !repForm) {
        throw new BadRequestException({ code: 'REP_FORM_REQUIRED', message: '리포트 대상이면 서식을 골라 주세요' });
      }
      const set: string[] = [];
      const vals: unknown[] = [key];
      const before: Record<string, unknown> = { key };
      const after: Record<string, unknown> = { key };
      const put = (col: string, field: string, old: unknown, v: unknown, cast = '') => {
        vals.push(v); set.push(`${col} = $${vals.length}${cast}`);
        before[field] = old; after[field] = v;
      };
      if (dto.name !== undefined) put('name', 'name', cur.name, dto.name.trim());
      if (dto.color !== undefined) put('color', 'color', String(cur.color).trim(), dto.color);
      if (dto.cap !== undefined) put('cap', 'cap', Number(cur.cap), dto.cap);
      if (dto.grp !== undefined) put('grp', 'grp', cur.grp, dto.grp, '::kind_grp_t');
      if (dto.sort !== undefined) put('sort', 'sort', cur.sort == null ? null : Number(cur.sort), dto.sort);
      if (dto.extra !== undefined) put('extra', 'extra', cur.extra === true, dto.extra);
      if (dto.rep !== undefined || dto.repForm !== undefined) {
        put('rep', 'rep', cur.rep === true, rep);
        put('rep_form', 'repForm', cur.rep_form, rep ? repForm : null);
      }
      if (!set.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: '바꿀 값이 없습니다' });
      await m.query(`UPDATE kind SET ${set.join(', ')} WHERE key = $1`, vals);
      await audit(m, 'catalog.kind', { actorId, entityId: CatalogService.KEYED_ENTITY_ID, action: 'patch', before, after });
      return this.one(m, key);
    });
  }

  private async one(m: EntityManager, key: string): Promise<KindRowsDto> {
    const [row] = (await m.query(
      `SELECT k.key,k.name,k.color,k.cap,k.grp,k.rep,k.rep_form,k.sort,k.extra,
              (SELECT count(*)::int FROM ser s WHERE s.kind_key = k.key) AS ser_count
         FROM kind k WHERE k.key = $1`, [key],
    )) as Array<Record<string, unknown>>;
    return this.kindRow(row);
  }

  async createSub(actorId: number, dto: SubCreateDto): Promise<SubRowDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [dup] = (await m.query(`SELECT key FROM sub WHERE key = $1`, [dto.key])) as { key: string }[];
      if (dup) throw new ConflictException({ code: 'SUB_KEY_TAKEN', message: `「${dto.key}」는 이미 있는 코드입니다` });
      await m.query(
        `INSERT INTO sub (key,name,color,active,sort) VALUES ($1,$2,$3,true,$4)`,
        [dto.key, dto.name.trim(), dto.color, dto.sort ?? null],
      );
      const made = await this.oneSub(m, dto.key);
      await audit(m, 'catalog.sub', {
        actorId, entityId: CatalogService.KEYED_ENTITY_ID, action: 'create',
        after: { key: made.key, name: made.name, color: made.color, active: made.active, sort: made.sort ?? null },
      });
      return made;
    });
  }

  /** 과목 고치기 — `active: false` 가 「끄기」다(원장의 after 에 그대로 남는다) */
  async patchSub(actorId: number, key: string, dto: SubPatchDto): Promise<SubRowDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [cur] = (await m.query(
        `SELECT key, name, color, active, sort FROM sub WHERE key = $1 FOR UPDATE`, [key],
      )) as Array<{ key: string; name: string; color: string; active: boolean; sort: number | null }>;
      if (!cur) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: '과목을 찾을 수 없습니다' });
      const set: string[] = [];
      const vals: unknown[] = [key];
      const before: Record<string, unknown> = { key };
      const after: Record<string, unknown> = { key };
      const put = (col: string, old: unknown, v: unknown) => {
        vals.push(v); set.push(`${col} = $${vals.length}`);
        before[col] = old; after[col] = v;
      };
      if (dto.name !== undefined) put('name', cur.name, dto.name.trim());
      if (dto.color !== undefined) put('color', String(cur.color).trim(), dto.color);
      if (dto.active !== undefined) put('active', cur.active === true, dto.active);
      if (dto.sort !== undefined) put('sort', cur.sort == null ? null : Number(cur.sort), dto.sort);
      if (!set.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: '바꿀 값이 없습니다' });
      await m.query(`UPDATE sub SET ${set.join(', ')} WHERE key = $1`, vals);
      await audit(m, 'catalog.sub', { actorId, entityId: CatalogService.KEYED_ENTITY_ID, action: 'patch', before, after });
      return this.oneSub(m, key);
    });
  }

  private async oneSub(m: EntityManager, key: string): Promise<SubRowDto> {
    const [row] = (await m.query(
      `SELECT b.key,b.name,b.color,b.active,b.sort,
              (SELECT count(*)::int FROM ser s WHERE s.sub_key = b.key) AS ser_count
         FROM sub b WHERE b.key = $1`, [key],
    )) as Array<Record<string, unknown>>;
    return this.subRow(row);
  }
}
