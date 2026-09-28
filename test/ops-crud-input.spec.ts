/** @file-guide
 * 목적: 기획 담당·마케팅 수정·건의 답변의 실제 ValidationPipe 입력 계약 회귀
 * 책임/재사용: 운영과 같은 whitelist·transform 설정으로 DTO만 검증한다. DB 행위는 각 flow DB spec이 담당한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ValidationPipe, type Type } from '@nestjs/common';
import { MarketingPatchDto, PlanOwnerPatchDto, SuggestionReplyDto } from '../src/modules/ops/ops.dto';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const parse = (dto: Type<unknown>, body: object) => pipe.transform(body, { type: 'body', metatype: dto });

describe('운영 CRUD 입력 계약', () => {
  it('기획 담당은 양의 안전한 정수 한 칸만 받는다', async () => {
    await expect(parse(PlanOwnerPatchDto, { ownerId: 7 })).resolves.toMatchObject({ ownerId: 7 });
    for (const ownerId of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(parse(PlanOwnerPatchDto, { ownerId })).rejects.toMatchObject({ status: 400 });
    }
    await expect(parse(PlanOwnerPatchDto, { ownerId: 7, stage: 'done' })).rejects.toMatchObject({ status: 400 });
  });

  it('마케팅 수정은 활동 칸의 null 초기화만 보존하고 성과 칸을 거절한다', async () => {
    await expect(parse(MarketingPatchDto, {
      title: '학습실 하루', channel: 'instagram', item: 'video', url: null, onDate: null, byId: null, memo: null,
    })).resolves.toMatchObject({ url: null, onDate: null, byId: null, memo: null });
    await expect(parse(MarketingPatchDto, { impressions: 10 })).rejects.toMatchObject({ status: 400 });
  });

  it('마케팅 URL·날짜·어휘를 DB 쓰기 전에 막는다', async () => {
    for (const body of [
      { url: 'javascript:alert(1)' }, { onDate: '2026-02-30' }, { channel: 'unknown' }, { item: 'unknown' },
    ]) await expect(parse(MarketingPatchDto, body)).rejects.toMatchObject({ status: 400 });
  });

  it('건의 답변은 1~2000자 문자열 한 칸만 받는다', async () => {
    await expect(parse(SuggestionReplyDto, { reply: '확인했습니다.' })).resolves.toMatchObject({ reply: '확인했습니다.' });
    for (const reply of ['', 'a'.repeat(2001), 7]) {
      await expect(parse(SuggestionReplyDto, { reply })).rejects.toMatchObject({ status: 400 });
    }
    await expect(parse(SuggestionReplyDto, { reply: '확인', state: 'done' })).rejects.toMatchObject({ status: 400 });
  });
});
