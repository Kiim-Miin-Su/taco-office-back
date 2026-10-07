/** @file-guide
 * 목적: BOC-03D-04b 신규 학생 15절의 정규화·기간·연락처·멱등 fingerprint 판정.
 * 책임/재사용: HTTP/DB 부수효과 없이 StudentCreateDto 의미만 소유하고 preview/save가 같은 결과를 사용한다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/sprint/TBO-55/BOC-03-SCENARIOS-2026-10-06.md
 */
import { createHash } from 'node:crypto';
import { isIsoDate, todayKst } from '../../lib/kst';
import { isEmail, phoneDigits } from '../notify/sender';
import type {
  StudentCreateDto, StudentRegistrationContactDto, StudentRegistrationPeriodDto,
  StudentRegistrationSummaryDto,
} from './student-registration.dto';

type Precision = 'year' | 'month' | 'day';

export interface NormalizedRegistrationPeriod {
  from: string;
  fromPrecision: Precision;
  to: string | null;
  toPrecision: Precision | null;
  memo: string | null;
}

export interface NormalizedRegistrationContact {
  kind: StudentRegistrationContactDto['kind'];
  value: string;
  label: string | null;
}

export interface NormalizedStudentCreateCommand {
  requestKey: string;
  entrySource: StudentCreateDto['entrySource'];
  leadId: number | null;
  name: string;
  englishName: string | null;
  gender: StudentCreateDto['gender'];
  schoolHistory: Array<NormalizedRegistrationPeriod & { schoolId: number }>;
  gradeHistory: Array<NormalizedRegistrationPeriod & { educationSystem: string; gradeCode: string }>;
  residenceHistory: Array<NormalizedRegistrationPeriod & { countryCode: string; timezone: string | null }>;
  textHistory: Array<NormalizedRegistrationPeriod & { field: StudentCreateDto['textHistory'][number]['field']; value: string }>;
  contacts: NormalizedRegistrationContact[];
  birthDate: string | null;
  hasCitizenship: boolean | null;
  guardians: Array<{
    relation: StudentCreateDto['guardians'][number]['relation'];
    relationOther: string | null;
    name: string | null;
    countryCode: string | null;
    isPrimary: boolean;
    isPayer: boolean;
    contacts: NormalizedRegistrationContact[];
  }>;
  cashReceiptNumber: string | null;
  siblingIds: number[];
  source: StudentCreateDto['source'];
  assigneeIds: number[];
  notes: string | null;
  allowSameName: boolean;
}

function invalid(code: string, message: string): never {
  throw new RangeError(`${code}: ${message}`);
}

const trimNullable = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

function lastDayOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const next = new Date(Date.UTC(nextYear, nextMonth - 1, 1));
  next.setUTCDate(0);
  return String(next.getUTCDate()).padStart(2, '0');
}

/** DTO는 canonical full date를 받고 precision은 원래 사용자가 안 경계를 보존한다. */
export function normalizeRegistrationPeriod(input: StudentRegistrationPeriodDto): NormalizedRegistrationPeriod {
  if (!isIsoDate(input.from) || input.to !== null && !isIsoDate(input.to)) {
    return invalid('STUDENT_REGISTRATION_PERIOD_INVALID', '기간은 실제 날짜여야 합니다');
  }
  if (input.to !== null && input.to < input.from) {
    return invalid('STUDENT_REGISTRATION_PERIOD_INVALID', '종료일은 시작일보다 앞설 수 없습니다');
  }
  if (input.fromPrecision === 'year' && !input.from.endsWith('-01-01')
    || input.fromPrecision === 'month' && !input.from.endsWith('-01')) {
    return invalid('STUDENT_REGISTRATION_PERIOD_INVALID', '시작 경계와 입력 정밀도가 맞지 않습니다');
  }
  if (input.to !== null) {
    if (input.toPrecision === 'year' && !input.to.endsWith('-12-31')) {
      return invalid('STUDENT_REGISTRATION_PERIOD_INVALID', '연 종료 경계는 12월 31일이어야 합니다');
    }
    if (input.toPrecision === 'month' && input.to.slice(8, 10) !== lastDayOfMonth(input.to)) {
      return invalid('STUDENT_REGISTRATION_PERIOD_INVALID', '월 종료 경계는 그 달의 마지막 날이어야 합니다');
    }
  }
  return {
    from: input.from,
    fromPrecision: input.fromPrecision,
    to: input.to,
    toPrecision: input.toPrecision,
    memo: trimNullable(input.memo ?? null),
  };
}

function periodsOverlap(left: NormalizedRegistrationPeriod, right: NormalizedRegistrationPeriod): boolean {
  return (left.to === null || right.from <= left.to) && (right.to === null || left.from <= right.to);
}

export function assertRegistrationPeriods(
  groups: ReadonlyArray<{ field: string; period: NormalizedRegistrationPeriod }>,
  requiredCurrent: readonly string[],
): void {
  for (const field of new Set(groups.map(({ field }) => field))) {
    const rows = groups.filter(row => row.field === field).map(row => row.period)
      .sort((a, b) => a.from.localeCompare(b.from));
    for (let index = 1; index < rows.length; index += 1) {
      if (periodsOverlap(rows[index - 1]!, rows[index]!)) {
        return invalid('STUDENT_REGISTRATION_PERIOD_CONFLICT', `${field} 기간이 겹칩니다`);
      }
    }
  }
  const today = todayKst();
  for (const field of requiredCurrent) {
    const current = groups.filter(row => row.field === field
      && row.period.from <= today && (row.period.to === null || row.period.to >= today));
    if (current.length !== 1) {
      return invalid('STUDENT_REGISTRATION_PERIOD_CURRENT_REQUIRED', `${field}의 현재 적용 기간이 하나 필요합니다`);
    }
  }
}

export function normalizeRegistrationContact(input: StudentRegistrationContactDto): NormalizedRegistrationContact {
  let value = input.value.trim();
  if (input.kind === 'email') {
    if (!isEmail(value)) return invalid('STUDENT_REGISTRATION_CONTACT_INVALID', '이메일 주소 모양이 아닙니다');
  } else if (input.kind === 'phone') {
    const domestic = phoneDigits(value);
    if (domestic) value = domestic;
    else {
      value = value.replace(/[\s()-]/g, '');
      if (!/^\+[1-9][0-9]{7,14}$/.test(value)) {
        return invalid('STUDENT_REGISTRATION_CONTACT_INVALID', '전화번호는 국내 휴대폰 또는 E.164 형식이어야 합니다');
      }
    }
  }
  if (!value) return invalid('STUDENT_REGISTRATION_CONTACT_INVALID', '연락처 값이 필요합니다');
  const label = input.kind === 'other' ? input.label?.trim() || null : null;
  if (input.kind === 'other' && !label) return invalid('STUDENT_REGISTRATION_CONTACT_INVALID', '기타 연락처 이름이 필요합니다');
  return { kind: input.kind, value, label };
}

function assertContactDuplicates(contacts: readonly NormalizedRegistrationContact[]): void {
  const seen = new Set<string>();
  for (const contact of contacts) {
    const canonical = contact.kind === 'email' ? contact.value.toLowerCase() : contact.value;
    const key = `${contact.kind}\u0000${canonical}\u0000${contact.label ?? ''}`;
    if (seen.has(key)) return invalid('STUDENT_REGISTRATION_CONTACT_DUPLICATE', '같은 연락처를 중복 입력할 수 없습니다');
    seen.add(key);
  }
}

/**
 * BOC-03D-04b 권고안 채택(2026-10-07): preview/save와 replay가 같은 정규화 명령을 사용한다.
 * notes는 KST 오늘부터 유효한 notes 기간으로 writer가 추가하고, 연락처/현금영수증 원문은 LOG·audit JSON에 넣지 않는다.
 */
export function normalizeStudentCreateCommand(dto: StudentCreateDto): NormalizedStudentCreateCommand {
  const contacts = dto.contacts.map(normalizeRegistrationContact);
  assertContactDuplicates(contacts);
  const guardians = dto.guardians.map(row => {
    const guardianContacts = row.contacts.map(normalizeRegistrationContact);
    assertContactDuplicates(guardianContacts);
    return {
      relation: row.relation,
      relationOther: trimNullable(row.relationOther),
      name: trimNullable(row.name),
      countryCode: row.countryCode,
      isPrimary: row.isPrimary,
      isPayer: row.isPayer,
      contacts: guardianContacts,
    };
  });
  if (guardians.filter(row => row.isPrimary).length > 1) {
    return invalid('STUDENT_REGISTRATION_PRIMARY_CONFLICT', '주보호자는 최대 한 명입니다');
  }
  const command: NormalizedStudentCreateCommand = {
    requestKey: dto.requestKey.toLowerCase(),
    entrySource: dto.entrySource,
    leadId: dto.leadId,
    name: dto.name.trim(),
    englishName: trimNullable(dto.englishName),
    gender: dto.gender,
    schoolHistory: dto.schoolHistory.map(row => ({ ...normalizeRegistrationPeriod(row), schoolId: row.schoolId })),
    gradeHistory: dto.gradeHistory.map(row => ({ ...normalizeRegistrationPeriod(row), educationSystem: row.educationSystem, gradeCode: row.gradeCode })),
    residenceHistory: dto.residenceHistory.map(row => ({ ...normalizeRegistrationPeriod(row), countryCode: row.countryCode, timezone: row.timezone })),
    textHistory: dto.textHistory.map(row => ({ ...normalizeRegistrationPeriod(row), field: row.field, value: row.value.trim() })),
    contacts,
    birthDate: dto.birthDate,
    hasCitizenship: dto.hasCitizenship,
    guardians,
    cashReceiptNumber: trimNullable(dto.cashReceiptNumber),
    siblingIds: [...dto.siblingIds].sort((a, b) => a - b),
    source: dto.source,
    assigneeIds: [...dto.assigneeIds].sort((a, b) => a - b),
    notes: trimNullable(dto.notes),
    allowSameName: dto.allowSameName,
  };
  if (command.birthDate !== null && command.birthDate > todayKst()) {
    return invalid('STUDENT_BIRTH_DATE_FUTURE', '생년월일은 KST 오늘 이후일 수 없습니다');
  }
  const periods: Array<{ field: string; period: NormalizedRegistrationPeriod }> = [
    ...command.schoolHistory.map(period => ({ field: 'school', period })),
    ...command.gradeHistory.map(period => ({ field: 'grade', period })),
    ...command.residenceHistory.map(period => ({ field: 'residence', period })),
    ...command.textHistory.map(period => ({ field: period.field, period })),
  ];
  if (command.notes) periods.push({
    field: 'notes',
    period: { from: todayKst(), fromPrecision: 'day', to: null, toPrecision: null, memo: null },
  });
  assertRegistrationPeriods(periods, ['grade', 'residence']);
  return command;
}

export function studentCreateFingerprint(command: NormalizedStudentCreateCommand): string {
  const body = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'requestKey'));
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

export function studentCreateSummary(command: NormalizedStudentCreateCommand): StudentRegistrationSummaryDto {
  return {
    schoolPeriods: command.schoolHistory.length,
    gradePeriods: command.gradeHistory.length,
    residencePeriods: command.residenceHistory.length,
    textPeriods: command.textHistory.length + (command.notes ? 1 : 0),
    studentContacts: command.contacts.length,
    guardians: command.guardians.length,
    siblingLinks: command.siblingIds.length,
    assignees: command.assigneeIds.length,
  };
}
