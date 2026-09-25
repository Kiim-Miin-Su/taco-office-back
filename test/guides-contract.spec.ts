/** @file-guide
 * 목적: §43~§45 안내 HTTP 계약의 권한·입력·위임 회귀를 검증한다.
 * 책임/재사용: 공용 Perm 메타데이터와 DTO validator를 검증하고 서비스 업무 SQL은 DB 스위트에 맡긴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PERM_KEY } from '../src/common/perm';
import { buildOpenApi } from '../src/openapi';
import { GuidesController } from '../src/modules/guides/guides.controller';
import { GuideActionDto, GuideBodyDto, GuideDraftCreateDto, GuideHistoryQueryDto, ZoomNoticeWriteDto } from '../src/modules/guides/guides.dto';
import { GuidesService } from '../src/modules/guides/guides.service';

describe('§43~§45 안내 HTTP 계약 (C78)', () => {
  const reflector = new Reflector();

  it.each(['all', 'students', 'history', 'templates'] as const)('%s 조회는 관리자 화면 권한을 요구한다', (handler) => {
    expect(reflector.get(PERM_KEY, GuidesController.prototype[handler])).toEqual(['canAdminPage']);
  });

  it.each(['createDraft', 'createTemplate', 'patchTemplate', 'writeBody', 'copyBody', 'sendZoomNotice', 'sendZoomNoticeBatch', 'sendGuide'] as const)(
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

  it('안내 작성의 지도 방향·관리자 코멘트는 선택이고 null 로 비울 수 있으나 4000자를 넘거나 글자가 아니면 거절한다 (g4 §44-3)', async () => {
    const ok = plainToInstance(GuideBodyDto, { body: '안내', direction: null, adminNote: '강사만 보는 말' });
    expect(await validate(ok)).toHaveLength(0);
    expect(await validate(plainToInstance(GuideBodyDto, { body: '안내' }))).toHaveLength(0);
    const bad = plainToInstance(GuideBodyDto, { body: '안내', direction: 'ㄱ'.repeat(4001), adminNote: 7 });
    expect((await validate(bad)).map((e) => e.property).sort()).toEqual(['adminNote', 'direction']);
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
    await controller.all(user);
    await controller.students(user);
    await controller.history(user, { span: 'week', anchor: '2026-09-14' });
    await controller.createDraft(user, { sourceOccurrenceId: 91, studentId: 19 });
    expect(service.all).toHaveBeenCalledWith(undefined, user);
    expect(service.students).toHaveBeenCalledWith(user);
    expect(service.history).toHaveBeenCalledWith({ span: 'week', anchor: '2026-09-14' }, user);
    expect(service.createDraft).toHaveBeenCalledWith(71, { sourceOccurrenceId: 91, studentId: 19 }, user);
  });

  it('§43-6 「강사 N명 한 번에」는 입력을 받지 않고 요청한 사람을 서비스에 넘긴다 — 고를 회차는 서버가 정한다 (wave 6)', async () => {
    const service = { sendZoomNoticeBatch: jest.fn().mockResolvedValue({ sent: [], skipped: [], teacherCount: 0, parentNotices: 0 }) } as unknown as GuidesService;
    const controller = new GuidesController(service);
    const user = { id: 72, name: '안내 담당', role: 'manager' };
    await controller.sendZoomNoticeBatch(user, {} as GuideActionDto);
    expect(service.sendZoomNoticeBatch).toHaveBeenCalledWith(user);
    // 화면이 회차 목록을 실어 보내면 거절한다 — 무엇을 보낼지 고르는 것은 서버의 같은 문(sendGate)이다
    await expect(controller.sendZoomNoticeBatch(user, { serIds: [1] } as unknown as GuideActionDto)).rejects.toThrow('입력 필드를 받지 않습니다');
    expect(service.sendZoomNoticeBatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * wave 6 — 생성 계약(OpenAPI)이 말하는 모양을 실제 Swagger builder 로 본다.
 * 서비스는 대역이고 여기서는 DTO 데코레이터가 만든 스키마만 본다.
 */
describe('§43-6 · §44-4 OpenAPI 계약 (wave 6)', () => {
  let doc: ReturnType<typeof buildOpenApi>;
  const schema = (name: string) => {
    const found = doc.components?.schemas?.[name];
    if (!found || '$ref' in found) throw new Error(`${name} schema 누락`);
    return found;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [GuidesController],
      providers: [{ provide: GuidesService, useValue: {} }],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    doc = buildOpenApi(app);
    await app.close();
  });

  it('GuideDto.kindLabel 은 필수 nullable 이다 — 서버는 언제나 싣고(mapGuide 한 곳) 모르는 사유만 null 이다', () => {
    const guide = schema('GuideDto');
    expect(guide.required).toContain('kindLabel');
    expect(guide.properties?.kindLabel).toMatchObject({ type: 'string', nullable: true });
  });

  it('POST /guides/zoom-notice/batch — 보낸 줄·건너뛴 줄(서버 이유)·강사 수를 돌려준다', () => {
    const post = doc.paths['/guides/zoom-notice/batch']?.post;
    expect(post?.responses['201']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ZoomNoticeBatchResultDto' } } },
    });
    expect(schema('ZoomNoticeBatchResultDto').required).toEqual(expect.arrayContaining(['sent', 'skipped', 'teacherCount', 'parentNotices']));
    const row = schema('ZoomNoticeBatchRowDto');
    expect(row.required).toEqual(expect.arrayContaining(['serId', 'onDate', 'startMin', 'studentNames', 'code', 'reason']));
    expect(row.properties?.reason).toMatchObject({ type: 'string', nullable: true });
  });

  it('GuidesDto.zoomBatch — 「강사 N명」의 N·회차 수·막힌 이유를 서버가 센다', () => {
    const guides = schema('GuidesDto');
    expect(guides.properties?.zoomBatch).toBeDefined();
    const info = schema('ZoomNoticeBatchInfoDto');
    expect(info.required).toEqual(expect.arrayContaining(['teacherCount', 'lessonCount', 'canSend', 'blockedReason']));
    expect(info.properties?.blockedReason).toMatchObject({ type: 'string', nullable: true });
  });
});
