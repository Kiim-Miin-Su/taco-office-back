import { lessonTimeIssue } from './recurrence';

/** CHREQ.req_type과 API가 공유하는 유일한 종류 목록. */
export const CHREQ_TYPES = ['time_move', 'teacher', 'room', 'cancel'] as const;
export type ChreqType = (typeof CHREQ_TYPES)[number];
export const isChreqType = (value: unknown): value is ChreqType =>
  typeof value === 'string' && (CHREQ_TYPES as readonly string[]).includes(value);

export interface ChangeRequestInput {
  reqType: unknown;
  serId?: unknown;
  onDate?: unknown;
  reason?: unknown;
  applyAll?: unknown;
  startMin?: unknown;
  endMin?: unknown;
  teacherId?: unknown;
  roomId?: unknown;
  zaccId?: unknown;
}

interface ChangeRequestTarget {
  serId: number;
  onDate: string;
  reason: string;
  applyAll: boolean;
}

export type NormalizedChangeRequest = ChangeRequestTarget & (
  | { reqType: 'time_move'; payload: { startMin: number; endMin: number } }
  | { reqType: 'teacher'; payload: { teacherId: number } }
  | { reqType: 'room'; payload: { roomId: number } | { zaccId: number } }
  | { reqType: 'cancel'; payload: Record<string, never> }
);

export interface ChangeRequestIssue {
  code: string;
  message: string;
}

export type ChangeRequestNormalization =
  | { ok: true; value: NormalizedChangeRequest }
  | { ok: false; issue: ChangeRequestIssue };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const isPositiveInt = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;
const isInt = (value: unknown): value is number => Number.isInteger(value);

function fail(code: string, message: string): ChangeRequestNormalization {
  return { ok: false, issue: { code, message } };
}

/**
 * 종류별 입력을 DB에 저장할 정확한 모양으로 좁힌다.
 * DTO, 충돌 미리보기, INSERT가 서로 payload를 다시 해석하지 않도록 이 함수만 사용한다.
 */
export function normalizeChangeRequest(input: ChangeRequestInput): ChangeRequestNormalization {
  if (!isChreqType(input.reqType)) {
    return fail('BAD_CHANGE_TYPE', '지원하지 않는 변경 요청 종류입니다');
  }
  if (!isPositiveInt(input.serId)) {
    return fail('TARGET_REQUIRED', '수업 번호를 선택해야 합니다');
  }
  if (!isIsoDate(input.onDate)) {
    return fail('TARGET_REQUIRED', '변경할 회차 날짜를 선택해야 합니다');
  }
  if (typeof input.reason !== 'string') {
    return fail('REASON_REQUIRED', '사유를 적어야 제출됩니다');
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return fail('REASON_REQUIRED', '사유를 적어야 제출됩니다');
  }
  if (reason.length > 500) {
    return fail('REASON_TOO_LONG', '사유는 500자까지 적을 수 있습니다');
  }
  if (input.applyAll !== undefined && typeof input.applyAll !== 'boolean') {
    return fail('BAD_APPLY_ALL', '이후 전체 적용 값이 올바르지 않습니다');
  }

  const target = {
    serId: input.serId,
    onDate: input.onDate,
    reason,
    applyAll: input.applyAll === true,
  };
  const supplied = (key: 'startMin' | 'endMin' | 'teacherId' | 'roomId' | 'zaccId') =>
    input[key] !== undefined;

  if (input.reqType === 'time_move') {
    if (!isInt(input.startMin) || !isInt(input.endMin)) {
      return fail('TIME_REQUIRED', '시작과 끝 시각을 모두 입력해야 합니다');
    }
    if (supplied('teacherId') || supplied('roomId') || supplied('zaccId')) {
      return fail('BAD_CHANGE_FIELDS', '시간 이동 요청에는 시각만 보낼 수 있습니다');
    }
    const issue = lessonTimeIssue(input.startMin, input.endMin);
    if (issue) return fail('BAD_RANGE', issue);
    return {
      ok: true,
      value: { ...target, reqType: input.reqType, payload: { startMin: input.startMin, endMin: input.endMin } },
    };
  }

  if (input.reqType === 'teacher') {
    if (!isPositiveInt(input.teacherId)) {
      return fail('TEACHER_REQUIRED', '바꿀 강사를 선택해야 합니다');
    }
    if (supplied('startMin') || supplied('endMin') || supplied('roomId') || supplied('zaccId')) {
      return fail('BAD_CHANGE_FIELDS', '강사 변경 요청에는 강사만 보낼 수 있습니다');
    }
    return { ok: true, value: { ...target, reqType: input.reqType, payload: { teacherId: input.teacherId } } };
  }

  if (input.reqType === 'room') {
    const hasRoom = supplied('roomId');
    const hasZoom = supplied('zaccId');
    if (hasRoom === hasZoom) {
      return fail('ROOM_REQUIRED', '강의실 또는 Zoom 계정 중 하나만 선택해야 합니다');
    }
    if (hasRoom && !isPositiveInt(input.roomId)) {
      return fail('ROOM_REQUIRED', '바꿀 강의실을 선택해야 합니다');
    }
    if (hasZoom && !isPositiveInt(input.zaccId)) {
      return fail('ROOM_REQUIRED', '바꿀 Zoom 계정을 선택해야 합니다');
    }
    if (supplied('startMin') || supplied('endMin') || supplied('teacherId')) {
      return fail('BAD_CHANGE_FIELDS', '강의실 변경 요청에는 강의실 또는 Zoom 계정만 보낼 수 있습니다');
    }
    return {
      ok: true,
      value: hasRoom
        ? { ...target, reqType: input.reqType, payload: { roomId: input.roomId as number } }
        : { ...target, reqType: input.reqType, payload: { zaccId: input.zaccId as number } },
    };
  }

  if (supplied('startMin') || supplied('endMin') || supplied('teacherId') || supplied('roomId') || supplied('zaccId')) {
    return fail('BAD_CHANGE_FIELDS', '취소 요청에는 변경 값을 보낼 수 없습니다');
  }
  return { ok: true, value: { ...target, reqType: input.reqType, payload: {} } };
}
