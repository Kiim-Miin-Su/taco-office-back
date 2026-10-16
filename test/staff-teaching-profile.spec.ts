/** @file-guide
 * 목적: BO-1014-STAFF 가능 과목과 학력 입력 DTO의 DB 없는 회귀(p8 결정 2026-10-16 반영).
 * 책임/재사용: 모양(배열·중복·길이·5행)은 DTO가, 과목의 종류·사용 여부와 학력 코드표는 서버 판정(staff-teaching-subject-db)이 막는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StaffCreateDto, StaffPatchDto } from '../src/modules/drawer/drawer.dto';
import { educationCodeIssues } from '../src/lib/staff-education';

const create = (extra: Record<string, unknown> = {}) => plainToInstance(StaffCreateDto, {
  name: '검증 강사', loginId: 'staff-teaching-test', password: 'ExamplePass123', role: 'teacher',
  ...extra,
});

describe('BO-1014-STAFF 수업 프로필 DTO', () => {
  it('가능 과목 key 목록과 학력 5행, 영어 전용 미확인 상태를 받는다', () => {
    const dto = create({
      birthOn: '1990-01-01', englishOnly: null, teachingSubjectKeys: ['map-read', 'mock-sat', 'study-room'],
      education: Array.from({ length: 5 }, (_, index) => ({ school: `검증 학교 ${index + 1}`, degree: '학사', status: '졸업' })),
    });
    expect(validateSync(dto)).toEqual([]);
  });

  it('가능 과목은 중복·과목 key 길이 초과·배열 아님을 저장 경계 전에 거절한다', () => {
    for (const keys of [['map-read', 'map-read'], ['x'.repeat(21)], 'map-read']) {
      const errors = validateSync(create({ teachingSubjectKeys: keys }));
      expect(errors.some((error) => error.property === 'teachingSubjectKeys')).toBe(true);
    }
  });

  it('학력 6행과 빈 학교를 거절하고 생년월일 null·빈 과목 목록 수정은 허용한다', () => {
    expect(validateSync(create({ education: Array.from({ length: 6 }, () => ({ school: '검증 학교' })) }))
      .some((error) => error.property === 'education')).toBe(true);
    expect(validateSync(create({ education: [{ school: '' }] }))
      .some((error) => error.property === 'education')).toBe(true);
    expect(validateSync(plainToInstance(StaffPatchDto, { birthOn: null, englishOnly: false, teachingSubjectKeys: [] }))).toEqual([]);
    expect(validateSync(create({ hiredOn: '2026-02-31' })).some((error) => error.property === 'hiredOn')).toBe(true);
  });

  it('학력 코드표 — 새 자유 입력은 막고 이미 저장된 옛 값은 다시 보낼 수 있다', () => {
    expect(educationCodeIssues([{ degree: '학사', status: '졸업' }, { degree: null, status: null }])).toEqual([]);
    expect(educationCodeIssues([{ degree: '공학사', status: '졸업 예정' }])).toEqual(['공학사', '졸업 예정']);
    expect(educationCodeIssues([{ degree: '공학사', status: '졸업 예정' }], [{ degree: '공학사', status: '졸업 예정' }])).toEqual([]);
  });
});
