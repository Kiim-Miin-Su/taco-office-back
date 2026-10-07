/** @file-guide
 * 목적: BOC-03D-03 학생 재활성화 상태·버전·멱등 순수 정책 회귀
 * 책임/재사용: DB writer를 흉내 내지 않고 공용 rules의 허용·거절 경계와 fingerprint 안정성만 검증한다.
 * 검증/작업 지침: docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md
 */

import type { StudentReactivationDto } from '../src/modules/students/student-registration.dto';
import {
  normalizeStudentReactivationCommand,
  studentReactivationFingerprint,
  studentReactivationNoEffects,
  studentReactivationRequestIssue,
  studentReactivationStatusIssue,
  studentReactivationVersionIssue,
} from '../src/modules/students/student-reactivation.rules';

const dto = (overrides: Partial<StudentReactivationDto> = {}): StudentReactivationDto => ({
  requestKey: '00000000-0000-4000-8000-0000000003AA',
  studentId: 31,
  expectedProfileVersion: '0',
  entrySource: 'students',
  leadId: null,
  reactivateOn: '2026-10-07',
  consultation: { channel: 'phone', content: '  재등록 상담\r\n다음 일정 확인  ', nextOn: '2026-10-10' },
  ...overrides,
});

describe('BOC-03D-03 학생 재활성화 권고 정책', () => {
  it('명시적 withdrawn만 허용하고 active/unknown/오염값은 fail-closed로 차단한다', () => {
    expect(studentReactivationStatusIssue('withdrawn')).toBeNull();
    expect(studentReactivationStatusIssue('active')?.code).toBe('STUDENT_REACTIVATION_ACTIVE');
    for (const status of ['unknown', null, undefined, '', 'paused', 'ended']) {
      expect(studentReactivationStatusIssue(status)?.code).toBe('STUDENT_REACTIVATION_STATUS_UNKNOWN');
    }
  });

  it('bigint version은 number 변환 없이 0을 포함한 decimal string으로 정확히 비교한다', () => {
    expect(studentReactivationVersionIssue('0', '0')).toBeNull();
    expect(studentReactivationVersionIssue('9007199254740993', '9007199254740993')).toBeNull();
    expect(studentReactivationVersionIssue('9007199254740993', '9007199254740992')?.code)
      .toBe('STUDENT_PROFILE_VERSION_CONFLICT');
  });

  it('requestKey와 상담 바깥 공백·개행만 정규화해 같은 업무 본문의 fingerprint를 고정한다', () => {
    const first = normalizeStudentReactivationCommand(dto());
    const retry = normalizeStudentReactivationCommand(dto({
      requestKey: '00000000-0000-4000-8000-0000000003aa',
      consultation: { channel: 'phone', content: '재등록 상담\n다음 일정 확인', nextOn: '2026-10-10' },
    }));
    expect(first.requestKey).toBe('00000000-0000-4000-8000-0000000003aa');
    expect(first.consultation.content).toBe('재등록 상담\n다음 일정 확인');
    expect(studentReactivationFingerprint(first)).toBe(studentReactivationFingerprint(retry));
    expect(studentReactivationRequestIssue(studentReactivationFingerprint(first), studentReactivationFingerprint(retry))).toBeNull();
  });

  it('같은 requestKey의 의미 있는 본문 변경은 409용 conflict로 판정한다', () => {
    const first = studentReactivationFingerprint(normalizeStudentReactivationCommand(dto()));
    for (const changed of [
      dto({ reactivateOn: '2026-10-08' }),
      dto({ expectedProfileVersion: '1' }),
      dto({ consultation: { channel: 'visit', content: '재등록 상담\n다음 일정 확인', nextOn: '2026-10-10' } }),
      dto({ consultation: { channel: 'phone', content: '다른 상담 내용', nextOn: '2026-10-10' } }),
    ]) {
      const next = studentReactivationFingerprint(normalizeStudentReactivationCommand(changed));
      expect(studentReactivationRequestIssue(first, next)?.code).toBe('STUDENT_REACTIVATION_REQUEST_KEY_REUSED');
    }
  });

  it('재활성화 결과는 신규 학생·수업·회계·교재·안내 side effect가 모두 0이다', () => {
    expect(studentReactivationNoEffects()).toEqual({
      studentCreated: false,
      enrollmentCreated: false,
      lessonCreated: false,
      invoiceCreated: false,
      bookIssueCreated: false,
      guideCreated: false,
      firstLessonTaskCreated: false,
    });
  });
});
