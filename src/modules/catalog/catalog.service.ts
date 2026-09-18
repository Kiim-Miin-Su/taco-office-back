/** @file-guide
 * 목적: catalog.service.ts — CatalogService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Kind } from '../../entities';
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

  async createKind(dto: KindCreateDto): Promise<KindRowsDto> {
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
      return this.one(m, dto.key);
    });
  }

  async patchKind(key: string, dto: KindPatchDto): Promise<KindRowsDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [cur] = (await m.query(
        `SELECT key, rep, rep_form FROM kind WHERE key = $1 FOR UPDATE`, [key],
      )) as { key: string; rep: boolean; rep_form: string | null }[];
      if (!cur) throw new NotFoundException({ code: 'KIND_NOT_FOUND', message: '프로그램을 찾을 수 없습니다' });
      const rep = dto.rep ?? cur.rep;
      const repForm = dto.repForm !== undefined ? dto.repForm : cur.rep_form;
      if (rep && !repForm) {
        throw new BadRequestException({ code: 'REP_FORM_REQUIRED', message: '리포트 대상이면 서식을 골라 주세요' });
      }
      const set: string[] = [];
      const vals: unknown[] = [key];
      const put = (col: string, v: unknown, cast = '') => { vals.push(v); set.push(`${col} = $${vals.length}${cast}`); };
      if (dto.name !== undefined) put('name', dto.name.trim());
      if (dto.color !== undefined) put('color', dto.color);
      if (dto.cap !== undefined) put('cap', dto.cap);
      if (dto.grp !== undefined) put('grp', dto.grp, '::kind_grp_t');
      if (dto.sort !== undefined) put('sort', dto.sort);
      if (dto.extra !== undefined) put('extra', dto.extra);
      if (dto.rep !== undefined || dto.repForm !== undefined) {
        put('rep', rep);
        put('rep_form', rep ? repForm : null);
      }
      if (!set.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: '바꿀 값이 없습니다' });
      await m.query(`UPDATE kind SET ${set.join(', ')} WHERE key = $1`, vals);
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

  async createSub(dto: SubCreateDto): Promise<SubRowDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [dup] = (await m.query(`SELECT key FROM sub WHERE key = $1`, [dto.key])) as { key: string }[];
      if (dup) throw new ConflictException({ code: 'SUB_KEY_TAKEN', message: `「${dto.key}」는 이미 있는 코드입니다` });
      await m.query(
        `INSERT INTO sub (key,name,color,active,sort) VALUES ($1,$2,$3,true,$4)`,
        [dto.key, dto.name.trim(), dto.color, dto.sort ?? null],
      );
      return this.oneSub(m, dto.key);
    });
  }

  async patchSub(key: string, dto: SubPatchDto): Promise<SubRowDto> {
    return this.kinds.manager.transaction(async (m: EntityManager) => {
      const [cur] = (await m.query(`SELECT key FROM sub WHERE key = $1 FOR UPDATE`, [key])) as { key: string }[];
      if (!cur) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: '과목을 찾을 수 없습니다' });
      const set: string[] = [];
      const vals: unknown[] = [key];
      const put = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (dto.name !== undefined) put('name', dto.name.trim());
      if (dto.color !== undefined) put('color', dto.color);
      if (dto.active !== undefined) put('active', dto.active);
      if (dto.sort !== undefined) put('sort', dto.sort);
      if (!set.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: '바꿀 값이 없습니다' });
      await m.query(`UPDATE sub SET ${set.join(', ')} WHERE key = $1`, vals);
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
