/** @file-guide
 * 목적: BOC-09D-03 강사 특이사항의 DTO·권한·OpenAPI projection 경계를 검증한다. (test)
 * 책임/재사용: DB 규칙은 DB suite에 맡기고 입력 형식, controller 위임, 본문 비노출 계약만 고정한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-09-SCENARIOS-2026-10-07.md · docs/contracts/CONTRACTS.md
 */
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERM_KEY } from '../src/common/perm';
import { PrivateNotesController } from '../src/modules/private-notes/private-notes.controller';
import { TeacherPrivateNoteWriteDto } from '../src/modules/private-notes/private-notes.dto';
import { PrivateNotesService } from '../src/modules/private-notes/private-notes.service';
import { buildOpenApi } from '../src/openapi';

describe('BOC-09D-03 강사 특이사항 DTO·권한·OpenAPI 계약', () => {
  const valid = {
    studentId: 11, serId: 22, onDate: '2026-10-07', body: '관리자 확인이 필요합니다.', expectedVersion: 0,
    requestKey: '11111111-1111-4111-8111-111111111111',
  };

  it('studentId+serId+원래 회차일+본문+version+UUID만 유효한 write 입력이다', async () => {
    expect(await validate(plainToInstance(TeacherPrivateNoteWriteDto, valid))).toHaveLength(0);
    for (const body of [
      { ...valid, studentId: 0 },
      { ...valid, serId: 1.5 },
      { ...valid, onDate: '2026-2-3' },
      { ...valid, body: 'x'.repeat(2001) },
      { ...valid, expectedVersion: -1 },
      { ...valid, requestKey: 'not-a-uuid' },
    ]) expect(await validate(plainToInstance(TeacherPrivateNoteWriteDto, body))).not.toHaveLength(0);
  });

  it('강사 write/receipt만 허용하고 관리자 역할은 강사 endpoint에서 차단한다', async () => {
    const service = {
      write: jest.fn().mockResolvedValue({ id: 1 }),
      receipts: jest.fn().mockResolvedValue({ items: [] }),
      studentNotes: jest.fn().mockResolvedValue({ studentId: 11, items: [] }),
    } as unknown as PrivateNotesService;
    const controller = new PrivateNotesController(service);
    const teacher = { id: 7, name: '강사', role: 'teacher' };
    await controller.write(teacher, valid);
    await controller.receipts(teacher);
    expect(service.write).toHaveBeenCalledWith(7, valid);
    expect(service.receipts).toHaveBeenCalledWith(7);
    expect(() => controller.write({ id: 8, name: '관리자', role: 'admin' }, valid)).toThrow(ForbiddenException);
    expect(() => controller.receipts({ id: 8, name: '관리자', role: 'admin' })).toThrow(ForbiddenException);
    expect(Reflect.getMetadata(PERM_KEY, controller.studentNotes)).toEqual(['canAdminPage', 'canCrudAll']);
  });

  it('OpenAPI는 강사 write/receipt와 관리자 학생별 reader를 분리하고 강사 응답에서 body를 제외한다', async () => {
    const service = { write: jest.fn(), receipts: jest.fn(), studentNotes: jest.fn() };
    const module = await Test.createTestingModule({
      controllers: [PrivateNotesController],
      providers: [{ provide: PrivateNotesService, useValue: service }],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.init();
    try {
      const doc = buildOpenApi(app);
      expect(doc.paths).toHaveProperty('/teacher/private-notes');
      expect(doc.paths).toHaveProperty('/teacher/private-notes/receipts');
      expect(doc.paths).toHaveProperty('/students/{studentId}/private-notes');
      const receipt = doc.components?.schemas?.TeacherPrivateNoteReceiptDto;
      const admin = doc.components?.schemas?.AdminStudentPrivateNoteDto;
      if (!receipt || '$ref' in receipt || !admin || '$ref' in admin) throw new Error('private note schema 누락');
      expect(receipt.properties).not.toHaveProperty('body');
      expect(admin.properties).toHaveProperty('body');
      expect(admin.properties).toHaveProperty('authorId');
    } finally {
      await app.close();
    }
  });
});
