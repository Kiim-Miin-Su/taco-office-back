/** @file-guide
 * 목적: §43~§45 안내 HTTP 계약의 권한·입력·위임 회귀를 검증한다.
 * 책임/재사용: 공용 Perm 메타데이터와 DTO validator를 검증하고 서비스 업무 SQL은 DB 스위트에 맡긴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { PERM_KEY } from '../src/common/perm';
import { GuidesController } from '../src/modules/guides/guides.controller';
import { GuideDraftCreateDto, GuideHistoryQueryDto, ZoomNoticeWriteDto } from '../src/modules/guides/guides.dto';
import { GuidesService } from '../src/modules/guides/guides.service';

describe('§43~§45 안내 HTTP 계약 (C78)', () => {
  const reflector = new Reflector();

  it.each(['all', 'students', 'history', 'templates'] as const)('%s 조회는 관리자 화면 권한을 요구한다', (handler) => {
    expect(reflector.get(PERM_KEY, GuidesController.prototype[handler])).toEqual(['canAdminPage']);
  });

  it.each(['createDraft', 'createTemplate', 'patchTemplate', 'writeBody', 'copyBody', 'sendZoomNotice'] as const)(
    '%s 쓰기는 관리자 화면과 전체 CRUD 권한을 모두 요구한다',
    (handler) => {
      expect(reflector.get(PERM_KEY, GuidesController.prototype[handler])).toEqual(['canAdminPage', 'canCrudAll']);
    },
  );

  it('이력 span/anchor와 초안 식별자는 DTO 경계에서 거절한다', async () => {
    const history = plainToInstance(GuideHistoryQueryDto, { span: 'quarter', anchor: '2026-02-30' });
    expect(await validate(history)).toHaveLength(2);
    const draft = plainToInstance(GuideDraftCreateDto, { sourceOccurrenceId: '1e3', studentId: 0 });
    expect(await validate(draft)).toHaveLength(2);
  });

  it('줌 안내는 회차 키 (serId, onDate) 만 받고 실제 달력 날짜가 아니면 거절한다 (C98 · F-63)', async () => {
    const bad = plainToInstance(ZoomNoticeWriteDto, { serId: '1e3', onDate: '2026-02-30' });
    const errors = await validate(bad);
    expect(errors.map((e) => e.property).sort()).toEqual(['onDate', 'serId']);
    // 재투영 때 바뀌는 sourceOccurrenceId 는 계약에 없다
    expect(Object.keys(plainToInstance(ZoomNoticeWriteDto, { serId: 1, onDate: '2026-09-19' }))).toEqual(['serId', 'onDate']);
  });

  it('컨트롤러는 이유·날짜·상태를 만들지 않고 서비스 계약에 그대로 위임한다', async () => {
    const service = {
      all: jest.fn().mockResolvedValue({ guides: [] }),
      students: jest.fn().mockResolvedValue({ items: [] }),
      history: jest.fn().mockResolvedValue({ days: [] }),
      createDraft: jest.fn().mockResolvedValue({ id: 9 }),
    } as unknown as GuidesService;
    const controller = new GuidesController(service);
    const user = { id: 71, name: '안내 담당', role: 'manager' };
    await controller.all();
    await controller.students();
    await controller.history({ span: 'week', anchor: '2026-09-14' });
    await controller.createDraft(user, { sourceOccurrenceId: 91, studentId: 19 });
    expect(service.all).toHaveBeenCalledWith();
    expect(service.students).toHaveBeenCalledWith();
    expect(service.history).toHaveBeenCalledWith({ span: 'week', anchor: '2026-09-14' });
    expect(service.createDraft).toHaveBeenCalledWith(71, { sourceOccurrenceId: 91, studentId: 19 });
  });
});
