/** @file-guide
 * 목적: BO-1014-STAFF 가능 수업 유형과 학력 입력 DTO의 DB 없는 회귀.
 * 책임/재사용: GPA/SUBJECT 혼입 및 5행 초과가 저장 경계 전에 거절되는지 확인한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StaffCreateDto, StaffPatchDto } from '../src/modules/drawer/drawer.dto';

const create = (extra: Record<string, unknown> = {}) => plainToInstance(StaffCreateDto, {
  name: '검증 강사', loginId: 'staff-teaching-test', password: 'ExamplePass123', role: 'teacher',
  ...extra,
});

describe('BO-1014-STAFF 수업 프로필 DTO', () => {
  it('KIND 수업 유형 3종과 학력 5행, 영어 전용 미확인 상태를 받는다', () => {
    const dto = create({
      birthOn: '1990-01-01', englishOnly: null, teachingKindKeys: ['class', 'mock', 'study'],
      education: Array.from({ length: 5 }, (_, index) => ({ school: `검증 학교 ${index + 1}` })),
    });
    expect(validateSync(dto)).toEqual([]);
  });

  it('GPA와 SUBJECT 과목 키를 가능 수업 유형에 섞지 않는다', () => {
    for (const key of ['gpa', 'english']) {
      const errors = validateSync(create({ teachingKindKeys: ['class', key] }));
      expect(errors.some((error) => error.property === 'teachingKindKeys')).toBe(true);
    }
  });

  it('학력 6행과 빈 학교를 거절하고 생년월일 null 수정은 허용한다', () => {
    expect(validateSync(create({ education: Array.from({ length: 6 }, () => ({ school: '검증 학교' })) }))
      .some((error) => error.property === 'education')).toBe(true);
    expect(validateSync(create({ education: [{ school: '' }] }))
      .some((error) => error.property === 'education')).toBe(true);
    expect(validateSync(plainToInstance(StaffPatchDto, { birthOn: null, englishOnly: false, teachingKindKeys: [] }))).toEqual([]);
    expect(validateSync(create({ hiredOn: '2026-02-31' })).some((error) => error.property === 'hiredOn')).toBe(true);
  });
});
