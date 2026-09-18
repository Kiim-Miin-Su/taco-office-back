/** @file-guide
 * 목적: meta.service.ts — MetaService (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 코드표 — 화면이 켜질 때 한 번 받아 둔다.
 *
 * 색·이름·정원이 여기서만 나오므로 명세서가 바뀌면 화면이 저절로 따라온다 (D-R18).
 * 컨트롤러는 권한만 보고 조회는 서비스가 갖는다 — 다른 아홉 모듈과 같은 모양이다.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Kind, Room, Staff, Stu, Sub, Zacc } from '../../entities';
import { INV_TYPES, INV_TYPE_LABEL, INV_TYPE_SUB } from '../accounting/accounting.dto';
import { permsOf } from '../../common/perm';
import {
  ATTENDANCE_CANCEL_REASONS, ATTENDANCE_CANCEL_REASON_LABEL, DEDUCTIBLE_CANCEL_REASONS,
  CANCEL_TREATS, CANCEL_TREAT_LABEL, CANCEL_TREAT_SUB,
} from '../../lib/rules';
import type { MetaDto } from './meta.dto';

@Injectable()
export class MetaService {
  constructor(
    @InjectRepository(Kind) private readonly kinds: Repository<Kind>,
    @InjectRepository(Sub) private readonly subs: Repository<Sub>,
    @InjectRepository(Room) private readonly rooms: Repository<Room>,
    @InjectRepository(Zacc) private readonly zaccs: Repository<Zacc>,
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    @InjectRepository(Stu) private readonly students: Repository<Stu>,
  ) {}

  async all(): Promise<MetaDto> {

    const [kinds, subs, rooms, zaccs, staff, students] = await Promise.all([
      this.kinds.find({ order: { sort: 'ASC' } }),
      this.subs.find({ where: { active: true }, order: { sort: 'ASC' } }),
      this.rooms.find({ where: { active: true }, order: { id: 'ASC' } }),
      this.zaccs.find({ where: { active: true }, order: { id: 'ASC' } }),
      this.staff.find({ where: { active: true }, order: { id: 'ASC' } }),
      this.students.find({ order: { id: 'ASC' } }),
    ]);
    return {
      kinds: kinds.map((k) => ({ key: k.key, name: k.name, color: k.color, cap: k.cap, grp: k.grp, rep: k.rep })),
      subs: subs.map((s) => ({ key: s.key, name: s.name, color: s.color })),
      rooms: rooms.map((r) => ({ id: Number(r.id), branch: r.branch, name: r.name, capacity: r.capacity })),
      zaccs: zaccs.map((z) => ({ id: Number(z.id), label: z.label, meetingId: z.meetingId })),
      staff: staff.map((s) => {
        const perms = permsOf(s.role, {
          canMoney: s.canMoney, canWage: s.canWage, canApprove: s.canApprove,
          canHide: s.canHide, canGpaPack: s.canGpaPack,
        });
        return {
          id: Number(s.id), name: s.name, role: s.role, title: s.title,
          canAdminPage: perms.canAdminPage, canGpaPack: perms.canGpaPack,
        };
      }),
      students: students.map((s) => ({ id: Number(s.id), name: s.name, grade: s.grade, school: s.school })),
      // 종류가 늘어도 화면은 그대로다 — 낱말이 한 곳에서만 온다 (D-R18)
      invTypes: INV_TYPES.map((key) => ({
        key, label: INV_TYPE_LABEL[key], sub: INV_TYPE_SUB[key], other: key !== 'tuition',
      })),
      // 휴강 창의 낱말과 정책 — 화면은 select 를 채우고 판정은 서버가 한다 (C92 · D-R39)
      cancelReasons: ATTENDANCE_CANCEL_REASONS.map((key) => ({
        key, label: ATTENDANCE_CANCEL_REASON_LABEL[key], deductible: DEDUCTIBLE_CANCEL_REASONS.includes(key),
      })),
      cancelTreats: CANCEL_TREATS.map((key) => ({ key, label: CANCEL_TREAT_LABEL[key], sub: CANCEL_TREAT_SUB[key] })),
    };
  }
}
