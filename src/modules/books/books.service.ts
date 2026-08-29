import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from '../../entities';
import type { BooksDto } from './books.dto';

type R = Record<string, unknown>;

@Injectable()
export class BooksService {
  constructor(@InjectRepository(Lead) private readonly anyRepo: Repository<Lead>) {}

  private q<T = R>(sql: string): Promise<T[]> {
    return this.anyRepo.query(sql) as Promise<T[]>;
  }

  async all(): Promise<BooksDto> {
    const rows = await this.q(
      `SELECT l.id, l.code, l.title, l.sub_key, l.level, l.grade, l.pages, l.se_te, s.name AS sub_name
         FROM lib l LEFT JOIN sub s ON s.key = l.sub_key
        ORDER BY l.sub_key NULLS LAST, l.code`,
    );

    const bySub: Record<string, number> = {};
    for (const r of rows) {
      const k = (r.sub_name as string) ?? '미분류';
      bySub[k] = (bySub[k] ?? 0) + 1;
    }

    return {
      bySub,
      items: rows.map((r) => ({
        id: Number(r.id), code: String(r.code), title: String(r.title),
        subKey: (r.sub_key as string) ?? null, subName: (r.sub_name as string) ?? null,
        level: (r.level as string) ?? null, grade: (r.grade as string) ?? null,
        pages: r.pages === null || r.pages === undefined ? null : Number(r.pages),
        seTe: (r.se_te as string) ?? null,
      })),
    };
  }
}
