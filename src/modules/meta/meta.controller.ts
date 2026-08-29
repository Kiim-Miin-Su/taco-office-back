import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Kind, Room, Staff, Stu, Sub, Zacc } from '../../entities';
import { MetaDto } from './meta.dto';

/**
 * 화면이 켜질 때 한 번 받아 두는 코드표.
 * 색·이름·정원이 여기서만 나오므로 명세서가 바뀌면 화면이 저절로 따라온다.
 */
@ApiTags('meta')
@Controller('meta')
export class MetaController {
  constructor(
    @InjectRepository(Kind) private readonly kinds: Repository<Kind>,
    @InjectRepository(Sub) private readonly subs: Repository<Sub>,
    @InjectRepository(Room) private readonly rooms: Repository<Room>,
    @InjectRepository(Zacc) private readonly zaccs: Repository<Zacc>,
    @InjectRepository(Staff) private readonly staff: Repository<Staff>,
    @InjectRepository(Stu) private readonly students: Repository<Stu>,
  ) {}

  @Get()
  @ApiOperation({ summary: '코드표 — 수업 종류 · 과목 · 강의실 · 줌 · 구성원 · 학생' })
  @ApiOkResponse({ type: MetaDto })
  async get(): Promise<MetaDto> {
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
      staff: staff.map((s) => ({ id: Number(s.id), name: s.name, role: s.role, title: s.title })),
      students: students.map((s) => ({ id: Number(s.id), name: s.name, grade: s.grade, school: s.school })),
    };
  }
}
