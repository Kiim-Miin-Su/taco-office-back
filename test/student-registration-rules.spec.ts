/** @file-guide
 * 목적: BOC-03D-04b 신규 학생 정규화·기간·연락처·fingerprint의 순수 회귀.
 * 책임/재사용: DB/HTTP 없이 제품 rules를 직접 검증한다. 영속화·동시성은 writer DB 시험이 소유한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md
 */
import { randomUUID } from 'node:crypto';
import { todayKst } from '../src/lib/kst';
import type { StudentCreateDto } from '../src/modules/students/student-registration.dto';
import {
  normalizeRegistrationPeriod,
  normalizeStudentCreateCommand,
  studentCreateFingerprint,
  studentCreateSummary,
} from '../src/modules/students/student-registration.rules';

const current = () => ({ from: todayKst(), fromPrecision: 'day' as const, to: null, toPrecision: null, memo: undefined });
const dto = (overrides: Partial<StudentCreateDto> = {}): StudentCreateDto => ({
  requestKey: randomUUID(), entrySource: 'students', leadId: null,
  name: '  등록 학생  ', englishName: '  Alex Kim  ', gender: 'female',
  schoolHistory: [],
  gradeHistory: [{ ...current(), educationSystem: 'KR', gradeCode: 'E6' }],
  residenceHistory: [{ ...current(), countryCode: 'KR', timezone: 'Asia/Seoul' }],
  textHistory: [], contacts: [{ kind: 'email', value: ' Student@Example.com ', label: null }],
  birthDate: null, hasCitizenship: null,
  guardians: [{ relation: 'mother', relationOther: null, name: null, countryCode: 'KR', isPrimary: true, isPayer: true,
    contacts: [{ kind: 'phone', value: '010-1234-5678', label: null }] }],
  cashReceiptNumber: null, siblingIds: [9, 2], source: 'referral', assigneeIds: [7, 3],
  notes: '  주의 메모  ', allowSameName: false,
  ...overrides,
});

describe('BOC-03D-04b student registration rules', () => {
  it('표시 문자열·연락처·정렬·notes를 canonical command와 summary로 만든다', () => {
    const command = normalizeStudentCreateCommand(dto());
    expect(command).toMatchObject({
      name: '등록 학생', englishName: 'Alex Kim', siblingIds: [2, 9], assigneeIds: [3, 7], notes: '주의 메모',
      contacts: [{ kind: 'email', value: 'Student@Example.com', label: null }],
      guardians: [{ name: null, contacts: [{ kind: 'phone', value: '01012345678', label: null }] }],
    });
    expect(studentCreateSummary(command)).toEqual({
      schoolPeriods: 0, gradePeriods: 1, residencePeriods: 1, textPeriods: 1,
      studentContacts: 1, guardians: 1, siblingLinks: 2, assignees: 2,
    });
  });

  it('requestKey만 바뀐 재시도는 같은 fingerprint이고 본문 변경은 달라진다', () => {
    const first = normalizeStudentCreateCommand(dto({ requestKey: '00000000-0000-4000-8000-000000000401' }));
    const retry = normalizeStudentCreateCommand(dto({ requestKey: '00000000-0000-4000-8000-000000000402' }));
    expect(studentCreateFingerprint(first)).toBe(studentCreateFingerprint(retry));
    expect(studentCreateFingerprint(normalizeStudentCreateCommand(dto({ name: '다른 학생' }))))
      .not.toBe(studentCreateFingerprint(first));
  });

  it('겹친 기간·현재값 누락·중복 연락·복수 주보호자·미래 생일을 명시 code로 거절한다', () => {
    const failures: Array<[StudentCreateDto, RegExp]> = [
      [dto({ gradeHistory: [
        { ...current(), educationSystem: 'KR', gradeCode: 'E6' },
        { ...current(), educationSystem: 'KR', gradeCode: 'M1' },
      ] }), /STUDENT_REGISTRATION_PERIOD_CONFLICT/],
      [dto({ gradeHistory: [{ from: '2000-01-01', fromPrecision: 'day', to: '2001-01-01', toPrecision: 'day', educationSystem: 'KR', gradeCode: 'E6' }] }), /STUDENT_REGISTRATION_PERIOD_CURRENT_REQUIRED/],
      [dto({ contacts: [
        { kind: 'email', value: 'Student@example.com', label: null },
        { kind: 'email', value: 'student@EXAMPLE.com', label: null },
      ] }), /STUDENT_REGISTRATION_CONTACT_DUPLICATE/],
      [dto({ guardians: [dto().guardians[0]!, { ...dto().guardians[0]!, relation: 'father' }] }), /STUDENT_REGISTRATION_PRIMARY_CONFLICT/],
      [dto({ birthDate: '9999-12-31' }), /STUDENT_BIRTH_DATE_FUTURE/],
    ];
    for (const [input, message] of failures) expect(() => normalizeStudentCreateCommand(input)).toThrow(message);
  });

  it('year/month precision은 canonical 경계만 허용한다', () => {
    expect(normalizeRegistrationPeriod({
      from: '2026-01-01', fromPrecision: 'year', to: '2026-12-31', toPrecision: 'year',
    })).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(() => normalizeRegistrationPeriod({
      from: '2026-02-02', fromPrecision: 'month', to: null, toPrecision: null,
    })).toThrow(/STUDENT_REGISTRATION_PERIOD_INVALID/);
    expect(() => normalizeRegistrationPeriod({
      from: '2026-02-01', fromPrecision: 'month', to: '2026-02-27', toPrecision: 'month',
    })).toThrow(/STUDENT_REGISTRATION_PERIOD_INVALID/);
  });
});
