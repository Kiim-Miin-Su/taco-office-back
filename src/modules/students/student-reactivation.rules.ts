/** @file-guide
 * 목적: 기존 학생 재활성화의 상태·버전·멱등 요청 판정
 * 책임/재사용: HTTP/DB 부수효과 없이 BOC-03D-03 정책만 소유한다. writer와 preview는 이 판정을 함께 사용한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-03D2-STUDENT-REACTIVATION-CONTRACT-2026-10-07.md
 */

import { createHash } from 'node:crypto';
import { REACTIVATION_STATUSES, type StudentReactivationDto, type StudentReactivationEffectsDto } from './student-registration.dto';

export const STUDENT_REACTIVATION_STATUSES = REACTIVATION_STATUSES;
export type StudentReactivationStatus = typeof STUDENT_REACTIVATION_STATUSES[number];

export interface StudentReactivationIssue {
  code:
    | 'STUDENT_REACTIVATION_ACTIVE'
    | 'STUDENT_REACTIVATION_STATUS_UNKNOWN'
    | 'STUDENT_PROFILE_VERSION_CONFLICT'
    | 'STUDENT_REACTIVATION_REQUEST_KEY_REUSED';
  message: string;
}

export interface NormalizedStudentReactivationCommand {
  requestKey: string;
  studentId: number;
  expectedProfileVersion: string;
  entrySource: StudentReactivationDto['entrySource'];
  leadId: number | null;
  reactivateOn: string;
  consultation: {
    channel: StudentReactivationDto['consultation']['channel'];
    content: string;
    nextOn: string | null;
  };
}

/**
 * BOC-03D-03 권고안 채택(2026-10-07): 휴원·수강 종료·현재 명단으로 퇴원을 추정하지 않는다.
 * DB가 명시적으로 보관한 권위 상태가 withdrawn일 때만 통과시키고 나머지는 fail-closed로 막는다.
 * 정책을 바꾸면 P-REACT, BOC-03 시나리오와 후속 status migration을 같은 청크에서 함께 바꾼다.
 */
export function studentReactivationStatusIssue(status: unknown): StudentReactivationIssue | null {
  if (status === 'withdrawn') return null;
  if (status === 'active') {
    return { code: 'STUDENT_REACTIVATION_ACTIVE', message: '현재 재원 중인 학생은 재활성화할 수 없습니다' };
  }
  return { code: 'STUDENT_REACTIVATION_STATUS_UNKNOWN', message: '학생 상태를 확인할 수 없어 재활성화할 수 없습니다' };
}

/** DB bigint를 number로 바꾸지 않고 정규 decimal string끼리 비교한다. */
export function studentReactivationVersionIssue(expected: string, current: string): StudentReactivationIssue | null {
  return expected === current ? null : {
    code: 'STUDENT_PROFILE_VERSION_CONFLICT',
    message: '학생 정보가 변경되었습니다. 후보를 다시 조회한 뒤 재시도해 주세요',
  };
}

/**
 * 같은 actor·requestKey의 요청 동일성을 비교할 정본이다. CRLF만 LF로 맞추고 상담 내용의 바깥 공백만 제거한다.
 * 문장 내부 공백과 날짜·채널은 사용자가 보낸 의미를 보존한다. requestKey는 identity라 fingerprint 본문에서는 제외한다.
 */
export function normalizeStudentReactivationCommand(dto: StudentReactivationDto): NormalizedStudentReactivationCommand {
  return {
    requestKey: dto.requestKey.toLowerCase(),
    studentId: dto.studentId,
    expectedProfileVersion: dto.expectedProfileVersion,
    entrySource: dto.entrySource,
    leadId: dto.leadId,
    reactivateOn: dto.reactivateOn,
    consultation: {
      channel: dto.consultation.channel,
      content: dto.consultation.content.replace(/\r\n?/g, '\n').trim(),
      nextOn: dto.consultation.nextOn,
    },
  };
}

export function studentReactivationFingerprint(command: NormalizedStudentReactivationCommand): string {
  const body = {
    studentId: command.studentId,
    expectedProfileVersion: command.expectedProfileVersion,
    entrySource: command.entrySource,
    leadId: command.leadId,
    reactivateOn: command.reactivateOn,
    consultation: command.consultation,
  };
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

export function studentReactivationRequestIssue(previousFingerprint: string, nextFingerprint: string): StudentReactivationIssue | null {
  return previousFingerprint === nextFingerprint ? null : {
    code: 'STUDENT_REACTIVATION_REQUEST_KEY_REUSED',
    message: '같은 요청 키가 다른 재활성화 내용에 사용되었습니다',
  };
}

/** 재활성화는 identity·상태·상담만 바꾸며 등록·수업·회계 side effect를 만들지 않는다. */
export const studentReactivationNoEffects = (): StudentReactivationEffectsDto => ({
  studentCreated: false,
  enrollmentCreated: false,
  lessonCreated: false,
  invoiceCreated: false,
  bookIssueCreated: false,
  guideCreated: false,
  firstLessonTaskCreated: false,
});
