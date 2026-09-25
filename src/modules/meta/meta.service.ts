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
import { INV_TYPES, INV_TYPE_LABEL, INV_TYPE_SUB, invTypeIssueBlockedReason } from '../accounting/accounting.dto';
import { permsOf } from '../../common/perm';
import {
  ATTENDANCE_CANCEL_REASONS, ATTENDANCE_CANCEL_REASON_LABEL, DEDUCTIBLE_CANCEL_REASONS,
  CANCEL_TREATS, CANCEL_TREAT_LABEL, CANCEL_TREAT_SUB, PENALTY_RULE,
} from '../../lib/rules';
import { teacherPolicies } from '../../lib/teacher-policy';
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

  /**
   * @param canSeeRoster 관리 화면(canAdminPage)인가. 아니면 **학생 명단과 줌 회의 번호를 싣지 않는다** —
   *   강사 화면이 쓰는 것은 과목·종류·줌 이름뿐이고, 학생 이름은 자기 수업 응답에서만 받는다.
   *   못 보면 조회 자체를 안 한다 (보안 검수 0925 · D-R39 「감추는 게 아니라 없다」). 기본값은 닫힘이다.
   */
  async all(canSeeRoster = false): Promise<MetaDto> {

    const [kinds, subs, rooms, zaccs, staff, students] = await Promise.all([
      this.kinds.find({ order: { sort: 'ASC' } }),
      this.subs.find({ where: { active: true }, order: { sort: 'ASC' } }),
      this.rooms.find({ where: { active: true }, order: { id: 'ASC' } }),
      this.zaccs.find({ where: { active: true }, order: { id: 'ASC' } }),
      this.staff.find({ where: { active: true }, order: { id: 'ASC' } }),
      canSeeRoster ? this.students.find({ order: { id: 'ASC' } }) : Promise.resolve([] as Stu[]),
    ]);
    return {
      kinds: kinds.map((k) => ({ key: k.key, name: k.name, color: k.color, cap: k.cap, grp: k.grp, rep: k.rep, extra: k.extra === true })),
      subs: subs.map((s) => ({ key: s.key, name: s.name, color: s.color })),
      rooms: rooms.map((r) => ({ id: Number(r.id), branch: r.branch, name: r.name, capacity: r.capacity })),
      zaccs: zaccs.map((z) => ({ id: Number(z.id), label: z.label, meetingId: canSeeRoster ? z.meetingId : null })),
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
        // 낼 수 있는가도 발행과 같은 판정이다 (PB-01) — 화면이 종류를 골라 놓고 409 를 받지 않게
        issuable: invTypeIssueBlockedReason(key) === null,
        issueBlockedReason: invTypeIssueBlockedReason(key),
      })),
      // 휴강 창의 낱말과 정책 — 화면은 select 를 채우고 판정은 서버가 한다 (C92 · D-R39)
      cancelReasons: ATTENDANCE_CANCEL_REASONS.map((key) => ({
        key, label: ATTENDANCE_CANCEL_REASON_LABEL[key], deductible: DEDUCTIBLE_CANCEL_REASONS.includes(key),
      })),
      cancelTreats: CANCEL_TREATS.map((key) => ({ key, label: CANCEL_TREAT_LABEL[key], sub: CANCEL_TREAT_SUB[key] })),
      // 리포트 지각 차감 — 판정 정본을 그대로 (작은 것부터). 화면은 금액을 적지 않고 이 배열을 그린다 (D-R32 · 2026-09-25)
      lateReportTiers: PENALTY_RULE.map(({ fromMinutes, amount, range, when, cut, tone }) => ({ fromMinutes, amount, range, when, cut, tone })),
      // 강사 화면 최상단 정책 띠 — 숫자는 판정 상수에서 (lib/teacher-policy · 2026-09-25)
      teacherPolicies: teacherPolicies(),
    };
  }
}
