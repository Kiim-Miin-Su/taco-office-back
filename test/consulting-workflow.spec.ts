/** @file-guide
 * 목적: §29 생성 DTO의 10종/날짜/지정 공개 교차 조건과 §30 파일 접근 회귀를 검증한다.
 * 책임/재사용: class-validator와 공용 권한 함수를 직접 호출하고 서비스 업무 규칙을 테스트에 재구현하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { validate } from 'class-validator';
import type { Repository } from 'typeorm';
import type { Lead } from '../src/entities';
import { ConsultingCreateDto, ConsultingShareUpdateDto } from '../src/modules/consulting/consulting.dto';
import { CONSULTING_TYPES } from '../src/modules/consulting/consulting.rules';
import { ConsultingService } from '../src/modules/consulting/consulting.service';

const validCreate = (): ConsultingCreateDto => Object.assign(new ConsultingCreateDto(), {
  consType: 'admissions', studentIds: [1, 2], requester: 'mother', ownerId: 3,
  amount: 1_200_000, sessions: 8, startOn: '2026-09-14', endOn: '2026-12-20', share: 'all',
});

describe('§29 컨설팅 생성 HTTP 계약', () => {
  it('기존 단일진실원 10코드만 받는다', async () => {
    expect(CONSULTING_TYPES).toEqual([
      'admissions', 'boarding', 'transfer', 'essay', 'interview',
      'exam', 'roadmap', 'college', 'portfolio', 'visa',
    ]);
    expect(await validate(validCreate())).toHaveLength(0);
    const wrong = validCreate();
    wrong.consType = 'international_school' as never;
    expect((await validate(wrong)).some((e) => e.property === 'consType')).toBe(true);
  });

  it('지정 공개는 pickedStaffIds 누락/중복을 DTO에서 막는다', async () => {
    const missing = validCreate(); missing.share = 'picked';
    expect((await validate(missing)).some((e) => e.property === 'pickedStaffIds')).toBe(true);
    const duplicate = validCreate(); duplicate.share = 'picked'; duplicate.pickedStaffIds = [3, 3];
    expect((await validate(duplicate)).some((e) => e.property === 'pickedStaffIds')).toBe(true);
    duplicate.pickedStaffIds = [3, 4];
    expect(await validate(duplicate)).toHaveLength(0);
  });

  it('지정 공개가 아니면 지정 목록은 생략하거나 빈 배열만 받는다', async () => {
    const forbidden = validCreate(); forbidden.pickedStaffIds = [3];
    expect((await validate(forbidden)).some((e) => e.property === 'pickedStaffIds')).toBe(true);
    forbidden.pickedStaffIds = [];
    expect(await validate(forbidden)).toHaveLength(0);

    const share = Object.assign(new ConsultingShareUpdateDto(), { share: 'private', pickedStaffIds: [3] });
    expect((await validate(share)).some((e) => e.property === 'pickedStaffIds')).toBe(true);
  });

  it('실재하지 않는 날짜도 YYYY-MM-DD 모양만으로 통과시키지 않는다', async () => {
    const wrong = validCreate(); wrong.startOn = '2026-02-30';
    expect((await validate(wrong)).some((e) => e.property === 'startOn')).toBe(true);
  });

  it('원본의 별표 필드인 요청자·시작일·종료일은 생략할 수 없다', async () => {
    for (const field of ['requester', 'startOn', 'endOn'] as const) {
      const missing = validCreate();
      delete (missing as unknown as Record<string, unknown>)[field];
      expect((await validate(missing)).some((e) => e.property === field)).toBe(true);
    }
  });
});

describe('§30 상세 원자성', () => {
  it('공개 판정 뒤 행이 사라지는 경계도 500 대신 404로 닫고 같은 트랜잭션/SHARE lock을 쓴다', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 1, stage: 'contract', contract_step: 1, amount: 1, share: 'all', owner_id: 3, is_picked: false }])
      .mockResolvedValueOnce([]);
    const transaction = jest.fn(async (work: (manager: { query: typeof query }) => Promise<unknown>) => work({ query }));
    const svc = new ConsultingService({ manager: { transaction } } as unknown as Repository<Lead>);

    await expect(svc.detail(3, true, false, 1)).rejects.toMatchObject({ status: 404 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR SHARE OF c');
  });
});
