/** @file-guide
 * 목적: teacher.dto.ts — TeacherLessonDto, TeacherWeekDto, TeacherTodoDto, TeacherSettingRequestDto, TeacherTimezoneDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { REP_STATE_T_VALUES, SUG_CAT_T_VALUES, SUG_STATE_T_VALUES } from '../../entities/enums';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';

/** 강사가 올리는 요청 갈래 — 내 설정 둘(덱 §8) + 교재 변경 · GPA 회차 요청(N-99 · W11) */
export const TEACHER_REQ_TYPES = ['wage_change', 'tz_change', 'book_change', 'gpa_request'] as const;
export type TeacherReqType = (typeof TEACHER_REQ_TYPES)[number];

const S = { type: String, nullable: true } as const;

/** 강사 덱 §7~9 — 홈의 수업 한 줄. 시각은 회차 span에서 KST 분 단위 정수로 뽑는다. */
export class TeacherLessonDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ description: 'YYYY-MM-DD (KST)' }) onDate!: string;
  @ApiProperty({ description: 'KST 0~1439 분' }) startMin!: number;
  @ApiProperty({ description: '분 단위 수업 길이' }) durMin!: number;
  @ApiProperty({ description: 'class·mock·gpa·study… (kind.key)' }) kindKey!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: 'offline' | 'online';
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional({ ...S, description: '대면이면 강의실 이름' }) roomName?: string | null;
  @ApiPropertyOptional({ ...S, description: '강의실 지점 (강남·송도·제주)' }) roomBranch?: string | null;
  @ApiPropertyOptional({ ...S, description: '온라인이면 줌 계정 라벨' }) zaccLabel?: string | null;
  @ApiPropertyOptional({ ...S, description: '수강 학생 이름 (·, 구분)' }) students?: string | null;
  @ApiProperty() canceled!: boolean;
  @ApiPropertyOptional({ ...S, description: '휴강 사유 낱말 — 「학생 결석」 「학원 사정」 … (C92 · C-31). 옛 휴강은 null' })
  cancelKindLabel?: string | null;
  @ApiProperty({ enum: [...REP_STATE_T_VALUES], description: '리포트 상태 — rep 행이 없으면 none' })
  repState!: string;
}

export class TeacherWeekDto {
  @ApiProperty({ description: '이번 주(월~일) 열린 수업 수 — 휴강·출결 취소 제외' }) lessons!: number;
  @ApiProperty({ description: '이번 주 열린 수업 총 시수(분)' }) minutes!: number;
  @ApiProperty({ description: '이번 주 지나간 열린 수업 중 리포트 대상 종류(kind.rep)의 미작성 수 — 리포트 목록과 같은 판정' }) unwritten!: number;
}

/** 강사 덱 slide 8 hero 「오늘 수업 3건 · 시수 5.5시간」 — 세는 일은 서버다 (D-R37 · N-19) */
export class TeacherDaySummaryDto {
  @ApiProperty({ description: '오늘(KST) 열린 수업 수 — 휴강·출결 취소 제외' }) lessons!: number;
  @ApiProperty({ description: '오늘 열린 수업 총 시수(분)' }) minutes!: number;
}

/** 홈 우측 「오늘 할 일」 — 판정은 전부 서버. 화면은 숫자만 읽는다. */
export class TeacherTodoDto {
  @ApiProperty({ description: '지나간 열린 수업(휴강·출결 취소 제외) 중 리포트 대상 종류의 미작성 (REPORT_UNWRITTEN_CANDIDATE_DB)' }) unwrittenReports!: number;
  @ApiProperty({ description: '승인 대기(wait) 리포트' }) waitingApprovals!: number;
  @ApiProperty({ description: '진행 중(pending) 스케줄 변경 요청' }) openChangeRequests!: number;
  @ApiProperty({ description: '진행 중(pending) 내 요청 — 시급 변경·불가 시간 등(req)' }) openStaffRequests!: number;
  @ApiProperty({ description: '진행 중(pending) 교재 변경 요청 — 홈 「교재 변경 요청 중」(강사 덱 §8 · N-99)' }) openBookChanges!: number;
}

/** 올려 둔 요청 한 건 — 「관리자 승인 후 적용」을 화면이 말할 수 있게 (강사 덱 §8) */
export class TeacherSettingRequestDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: TEACHER_REQ_TYPES }) reqType!: string;
  @ApiProperty({ description: '사람이 읽는 요청 이름 — 코드표는 서버가 소유한다 (D-R18)' }) label!: string;
  @ApiPropertyOptional({ ...S, description: '무엇으로 바꿔 달라고 했는지 한 줄' }) asked?: string | null;
  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] }) state!: string;
  @ApiProperty({ description: '올린 날 YYYY-MM-DD' }) createdOn!: string;
  @ApiPropertyOptional({ ...S, description: '반려 사유 (D-R13)' }) rejectReason?: string | null;
}

export class TeacherTimezoneDto {
  @ApiProperty({ description: 'IANA 이름 — staff.tz 에 그대로 들어간다' }) tz!: string;
  @ApiProperty() name!: string;
}

export class TeacherSettingsDto {
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'IANA 시간대 — staff.tz' }) timezone!: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '현재 적용 시급(원/시간) — 본인만 조회' })
  wageRate?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 시급 적용 시작일' }) wageFrom?: string | null;
  @ApiProperty({ type: [TeacherTimezoneDto], description: '고를 수 있는 시간대 — TZG 표가 코드표다' })
  timezones!: TeacherTimezoneDto[];
  @ApiProperty({ type: [TeacherSettingRequestDto], description: '최근 내 설정 요청 (새것 먼저)' })
  requests!: TeacherSettingRequestDto[];
  @ApiProperty({ description: '시급 변경을 지금 신청할 수 있는가 — **한 달에 한 번**이다 (강사 덱 §8 원문)' })
  canAskWage!: boolean;
  @ApiPropertyOptional({ ...S, description: '못 하면 언제부터 되는지 YYYY-MM-DD' }) wageAskableOn?: string | null;
  @ApiProperty({ description: '시간대 변경을 지금 신청할 수 있는가 — 진행 중인 건이 있으면 false' })
  canAskTz!: boolean;
}

/** 강사가 올리는 내 설정 변경 요청 — 적용은 관리자 승인 뒤다 (덱 §8) */
export class TeacherSettingReqCreateDto {
  @ApiProperty({ enum: TEACHER_REQ_TYPES, description: '시급 · 시간대(덱 §8) · 교재 변경(수업 안내의 교재 행) · GPA 회차 요청(캘린더의 GPA 회차) — N-99' })
  @IsIn([...TEACHER_REQ_TYPES])
  reqType!: TeacherReqType;

  @ApiPropertyOptional({ description: '시급 변경일 때 바라는 시급(원/시간). 정수' })
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000)
  rate?: number;

  @ApiPropertyOptional({ description: '시간대 변경일 때 바라는 IANA 시간대 — TZG 에 있는 값만' })
  @IsOptional() @IsString() @MaxLength(40)
  timezone?: string;

  @ApiPropertyOptional({ description: '사유 — 교재 변경은 필수(400 REASON_REQUIRED) · 나머지는 선택' })
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;

  /* ── N-99 교재 변경 · GPA 회차 요청 — 학생은 **내 담당 학생만**(서버가 본다) ── */
  @ApiPropertyOptional({ description: '교재 변경 · GPA 회차 요청의 학생 id' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  studentId?: number;

  @ApiPropertyOptional({ description: '교재 변경 — 바꿔 달라는 배부(issue) id. 그 학생의 사용 중인 교재여야 한다' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  issueId?: number;

  @ApiPropertyOptional({ description: 'GPA 회차 요청 — 내 GPA 수업 회차의 규칙 id(SER)' })
  @IsOptional() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  serId?: number;

  @ApiPropertyOptional({ ...DATE_SCHEMA, description: 'GPA 회차 요청 — 그 회차의 날짜 YYYY-MM-DD(시각은 회차에서 서버가 읽는다)' })
  @IsOptional() @IsCalendarDate()
  onDate?: string;

  @ApiPropertyOptional({ maxLength: 8, description: 'GPA 회차 요청 — 서비스 키(GET /teacher/gpa-request-options). 포인트는 승인 때 규정에서 스냅숏' })
  @IsOptional() @IsString() @MaxLength(8)
  svcKey?: string;
}

/** GPA 서비스 규정 한 줄 — 강사 「GPA 회차 요청」 고르기(N-99). 표는 GPASVC 하나다 */
export class TeacherGpaServiceDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '규정 포인트 — 승인 때 GPA 기록에 스냅숏된다' }) point!: number;
}

/** 요청할 수 있는 GPA 회차의 명단 한 사람 — 그날 명단(serStuOn) 그대로 */
export class TeacherGpaOccurrenceStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
}

/** 요청할 수 있는 내 GPA 회차 한 줄 — 쓰기(`gpa_request`)가 받는 것과 같은 판정으로 고른다(N-99) */
export class TeacherGpaOccurrenceDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ ...DATE_SCHEMA }) onDate!: string;
  @ApiProperty({ description: '시작 분(KST) — 그날 놓인 자리' }) startMin!: number;
  @ApiProperty({ description: '끝 분(KST)' }) endMin!: number;
  @ApiProperty({ type: String, nullable: true, description: '규칙 제목 — 없으면 과목 · 종류 이름(화면은 코드표로 적는다)' }) title!: string | null;
  @ApiProperty({ type: String, nullable: true }) subKey!: string | null;
  @ApiProperty() kindKey!: string;
  @ApiProperty({ type: [TeacherGpaOccurrenceStudentDto], description: '그날 명단' }) students!: TeacherGpaOccurrenceStudentDto[];
}

/** 강사 「GPA 회차 요청」 창 한 벌 — 서비스 규정 · 고를 수 있는 회차(N-99). 화면은 거르지 않고 그린다 */
export class TeacherGpaRequestOptionsDto {
  @ApiProperty({ type: [TeacherGpaServiceDto] }) services!: TeacherGpaServiceDto[];
  @ApiProperty({
    type: [TeacherGpaOccurrenceDto],
    description: '내 GPA 수업 회차 중 휴강이 아니고 날짜를 품는 열린 사이클이 있는 것 — 요청 쓰기와 같은 판정',
  })
  occurrences!: TeacherGpaOccurrenceDto[];
}

/** GET /teacher/home — 강사 홈 한 번에 (덱 §7~9 · 강사 전용, 서버가 본인으로 고정) */
export class TeacherHomeDto {
  @ApiProperty({ description: '기준일 YYYY-MM-DD (KST 오늘)' }) todayDate!: string;
  @ApiProperty({ type: [TeacherLessonDto], description: '오늘 수업 (시각 순)' }) today!: TeacherLessonDto[];
  @ApiProperty({ type: [TeacherLessonDto], description: '내일부터 7일' }) upcoming!: TeacherLessonDto[];
  @ApiProperty({ type: TeacherDaySummaryDto, description: 'hero 「오늘 수업 N건 · 시수 N시간」 — today 목록과 같은 날·같은 판정' })
  todaySummary!: TeacherDaySummaryDto;
  @ApiProperty({ type: TeacherWeekDto }) week!: TeacherWeekDto;
  @ApiProperty({ type: TeacherTodoDto }) todo!: TeacherTodoDto;
  @ApiProperty({ type: TeacherSettingsDto }) settings!: TeacherSettingsDto;
}

/* ══ 수업 히스토리 (강사 덱 §29~31) ═══════════════════════════════════ */

export class TeacherHistoryQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM (KST) — 없으면 이번 달' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month는 YYYY-MM 형식입니다' })
  month?: string;
}

/** 히스토리의 수업 한 줄 — 금액은 본인 것만 실리는 표면이므로 projection 없이 그대로 준다. */
export class TeacherHistoryLessonDto {
  @ApiProperty() serId!: number;
  @ApiProperty({ description: 'YYYY-MM-DD (KST)' }) onDate!: string;
  @ApiProperty({ description: 'KST 0~1439 분' }) startMin!: number;
  @ApiProperty({ description: '분 단위 수업 길이' }) durMin!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: 'offline' | 'online';
  @ApiPropertyOptional(S) title?: string | null;
  @ApiPropertyOptional({ ...S, description: '수강 학생 이름 (·, 구분)' }) students?: string | null;
  @ApiProperty({ description: '명단 수 — «외 N명» 표기용' }) studentCount!: number;
  @ApiProperty({ enum: [...REP_STATE_T_VALUES] }) repState!: string;
  @ApiProperty() canceled!: boolean;
  @ApiPropertyOptional({ ...S, description: '최초 제출 시각 (KST) YYYY-MM-DD HH:mm — 재제출은 바꾸지 않는다 (D-R7)' })
  submittedAt?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '제출분 수업료 — 그 수업일 시급×시간, 정수 절사 (가산은 bonus 에 따로)' })
  pay?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '제출분 확정 지각 차감 (D-R32 — 최초 제출 기준)' })
  lateCut?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '종료 후 미제출분 — 지금 제출하면 붙는 차감 (D-R32)' })
  penaltyIfNow?: number | null;
  /* ── W11 M2 (N-36 · N-51 · N-93) ── */
  @ApiProperty({ type: Number, nullable: true, description: '가산 — 가산 규칙(N-93)이 그 날짜에 붙인 돈 · 쓴 수업 · 보정 줄만' })
  bonus!: number | null;
  @ApiProperty({ enum: ['written', 'correction', 'late', 'unwritten', 'canceled', 'na', 'upcoming'], description: '정산 갈래 — 대표 시트와 같은 함수' })
  settle!: string;
  @ApiProperty({ description: '갈래 이름 — 「리포트 씀」 · 「보정 · 8월 회차」 · 「확정된 달 — 다음 달 보정」 … (서버 낱말)' })
  settleLabel!: string;
  @ApiProperty({ ...S, description: '보정 줄의 원래 달 YYYY-MM' }) correctionOf!: string | null;
  @ApiProperty({ ...S, description: '확정 뒤에 쓴 회차가 지급된 달 YYYY-MM — 아직이면 null' }) paidIn!: string | null;
  @ApiProperty({ description: '값이 지급 확정 근거 줄에서 왔는가 — 확정된 달은 굳은 값이다' }) frozen!: boolean;
}

export class TeacherHistoryStatsDto {
  @ApiProperty({ description: '종료된 수업 (취소 제외)' }) doneCount!: number;
  @ApiProperty() doneMinutes!: number;
  @ApiProperty({ description: '리포트 제출분 — 승인 여부는 보지 않는다 (D-R7)' }) writtenCount!: number;
  @ApiProperty() writtenMinutes!: number;
  @ApiProperty({ description: '종료 후 미작성' }) unwrittenCount!: number;
  @ApiProperty() unwrittenMinutes!: number;
}

/**
 * 월 정산 — 저장된 payout 행이 있으면 **그 값이 정본**이고, 없으면 실시간 계산이다
 * (D-R7 리포트 기준 시수 · D-R32 지각 차감 · D-15 원천징수).
 *
 * 두 가지는 **다른 질문**이라 칸을 나눈다 (N-27 · 대표 결정 2026-09-12).
 *   `confirmed` — 확정됐는가. 판정은 `lib/rules` 한 곳에서 `confirmed_by` 로 낸다.
 *   `saved`     — 지금 보이는 숫자가 저장값인가. 행은 있는데 아직 아무도 확정하지 않았을 수 있다.
 * 전에는 「행이 있다」를 곧 「확정」으로 썼고, 화면은 `payout.state` 낱말로 셋을 또 갈랐다.
 * 그래서 마감 작성 중인 정산이 강사에게 「확정」으로 보였다.
 */
export class TeacherSettlementDto {
  @ApiProperty({ description: 'YYYY-MM' }) yearMonth!: string;
  @ApiProperty({ description: '확정됐는가 — 누가 확정했는가(confirmed_by)로 본다 (N-27)' }) confirmed!: boolean;
  @ApiProperty({ description: '저장된 정산 행에서 온 숫자인가 — false 면 실시간 계산이다' }) saved!: boolean;
  @ApiProperty({ description: '제출 인정 시수(분)' }) writtenMinutes!: number;
  @ApiProperty({ description: '시급×인정 시수 (정수 절사)' }) gross!: number;
  @ApiProperty({ description: '지각 차감 합 (D-R32)' }) lateCut!: number;
  @ApiProperty({ description: '소득세 3% 절사 (D-15)' }) incomeTax!: number;
  @ApiProperty({ description: '지방소득세 = 소득세의 10% 절사' }) localTax!: number;
  @ApiProperty({ description: '실지급 (예정)액' }) net!: number;
  @ApiProperty({ description: '종료 후 미작성 — 지금 쓰면 들어올 몫' }) unwrittenCount!: number;
  @ApiProperty() unwrittenMinutes!: number;
  @ApiProperty({ description: '미작성분 예상 금액 (시급 기준)' }) unwrittenAmount!: number;
  @ApiProperty({ description: '이 달 남은 예정 수업' }) remainingCount!: number;
  @ApiProperty() remainingMinutes!: number;
  @ApiProperty({ description: '남은 예정 예상 금액 (시급 기준)' }) remainingAmount!: number;
  /* ── W11 M2 (N-51 · N-93) ── */
  @ApiProperty({ description: '가산 합 — 총액(gross) 안에 들어 있다 (N-93)' }) bonus!: number;
  @ApiProperty({ description: '이 달에 보정으로 들어온 앞선 확정 달 회차 수 (N-51)' }) correctionCount!: number;
  @ApiProperty({ description: '이 달의 회차인데 확정 뒤에 써서 다음 달 보정으로 간 수 (N-51)' }) lateCount!: number;
  @ApiProperty({ ...S, description: '확정 · 보정 안내 한 문장(서버) — 「확정된 달 — 다음 달 보정」 등 · 없으면 null' }) note!: string | null;
}

/** 강사 화면의 가산 규칙 한 칸 — 강사 덱 §30 오른쪽 규칙 상자 (N-93 · 오늘 걸린 줄) */
export class TeacherBonusRuleDto {
  @ApiProperty({ description: '칸 이름 — 「모의수업」 · 「진단고사」 · 「Kinder 수업」 · 「그룹 학생 한 명 늘 때」' }) label!: string;
  @ApiProperty({ description: '도움말 — 「한 번에 얼마」 · 「시급에 더함」 · 「한 명당」' }) hint!: string;
  @ApiProperty({ type: Number, nullable: true, description: '오늘 걸린 금액 — 적은 줄이 없으면 null(가산 없음)' }) amount!: number | null;
  @ApiProperty({ description: '셈에 실제로 드는가 — Kinder 는 표시가 없어 false' }) applied!: boolean;
  @ApiProperty({ ...S, description: '셈에 안 드는 까닭' }) note!: string | null;
}

/* ══ 건의 사항 (강사 덱 §33~34 · D-11 분류 · D-12 상태 · 월 3회 서버 쿼터) ══ */

export class TeacherSuggestionDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: [...SUG_CAT_T_VALUES], description: '수업·시급·스케줄·기타 (D-11 확정)' })
  category!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: [...SUG_STATE_T_VALUES], description: '접수됨·확인 중·답변 완료 (D-12)' })
  state!: string;
  @ApiProperty({ description: '등록일 YYYY-MM-DD (KST)' }) createdOn!: string;
  @ApiPropertyOptional(S) reply?: string | null;
  @ApiPropertyOptional({ ...S, description: '답변한 관리자 이름' }) replyBy?: string | null;
  @ApiPropertyOptional({ ...S, description: '답변일 YYYY-MM-DD (KST)' }) replyOn?: string | null;
}

/** GET /teacher/suggestions — 내가 보낸 건의 + 이달 쿼터. canPost 는 서버 판정 플래그다 (화면 재판정 금지). */
export class TeacherSuggestionsDto {
  @ApiProperty({ description: '쿼터 기준 달 YYYY-MM (KST)' }) yearMonth!: string;
  @ApiProperty({ description: '이달 등록 수' }) used!: number;
  @ApiProperty({ description: '월 한도 — 서버 상수' }) limit!: number;
  @ApiProperty({ description: '남은 횟수' }) remaining!: number;
  @ApiProperty({ description: '지금 등록 가능한가 — 서버가 판정한 값만 소비한다' }) canPost!: boolean;
  @ApiProperty({ type: [TeacherSuggestionDto], description: '최근 순' }) items!: TeacherSuggestionDto[];
}

export class TeacherSuggestionCreateDto {
  @ApiProperty({ enum: [...SUG_CAT_T_VALUES], description: 'D-11 분류 4종' })
  @IsIn([...SUG_CAT_T_VALUES], { message: '분류는 수업·시급·스케줄·기타 중 하나입니다' })
  category!: string;
  @ApiProperty({ description: '건의 내용 — 1~2000자' })
  @IsString()
  @MinLength(1, { message: '내용을 적어 주세요' })
  @MaxLength(2000, { message: '내용은 2000자 이내입니다' })
  body!: string;
}

/* ══ 수업 안내 (강사 덱 §10~13 — 이번 주 담당 학생·교재·진단·수업 설정) ══ */

export class TeacherGuideLessonDto {
  /** 진단을 「어느 수업에서 봤는가」로 달 수 있게 회차의 시리즈 id 를 함께 준다 (C61) */
  @ApiProperty({ description: '이 회차의 시리즈 id' }) serId!: number;
  @ApiProperty({ description: 'YYYY-MM-DD (KST)' }) onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() durMin!: number;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional(S) title?: string | null;
}

export class TeacherGuideBookDto {
  @ApiProperty() issueId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) subKey?: string | null;
  @ApiPropertyOptional({ ...S, description: '교재 레벨 — 코드표 레벨(N-47) 낱말이 있으면 그것, 아직이면 옛 원문(lib.level) · 서가와 같은 함수(W11 A 후속)' }) level?: string | null;
  @ApiProperty({ description: 'SE | TE' }) seTe!: string;
  @ApiProperty({ description: '배부일 YYYY-MM-DD' }) issuedOn!: string;
  @ApiPropertyOptional({ ...S, description: '반환일 — null 이면 사용 중' }) returnedOn?: string | null;
  @ApiPropertyOptional({ description: '이 교재에 진행 중인 변경 요청이 있는가 — 「변경 요청」이 「변경 요청 중」으로 선다(N-99)' })
  changePending?: boolean;
  @ApiPropertyOptional({ description: '「변경 요청」이 눌리는가 — 쓰는 중(사용 중)이고 열린 요청이 없을 때만. 쓰기와 같은 판정(N-99)' })
  changeRequestable?: boolean;
}

/** 인수인계 메모 한 줄 — 관리자 · 매니저가 §79 학생 트래킹에서 적은 것 (N-36 ② · 학부모에게 나가지 않는다) */
export class TeacherGuideNoteDto {
  @ApiProperty() id!: number;
  @ApiProperty() body!: string;
  @ApiProperty({ ...S, description: '적은 사람' }) authorName!: string | null;
  @ApiProperty({ description: '적은 시각 — KST ISO(…+09:00)' }) createdAt!: string;
}

export class TeacherGuideDiagDto {
  @ApiPropertyOptional({ ...S, description: '응시일 YYYY-MM-DD' }) onDate?: string | null;
  @ApiProperty() levelSummary!: string;
  @ApiPropertyOptional(S) strengths?: string | null;
  @ApiPropertyOptional(S) weaknesses?: string | null;
  /** 강사 원문 슬라이드 20 — 진단 리포트는 「현재 수준 · 강점과 약점」과 **「권장 커리큘럼」** 두 줄이다 */
  @ApiPropertyOptional({ ...S, description: '권장 커리큘럼 — 원문 04 진단 리포트의 둘째 줄' })
  curriculum?: string | null;
  @ApiPropertyOptional({ ...S, description: '쓴 사람 — 조회하는 쪽이 누구 글인지 알아야 한다' })
  byName?: string | null;
}

/**
 * 진단 리포트 쓰기 — 강사 원문 슬라이드 20 「04 진단 리포트 · 신규 학생 첫 수업」.
 *
 * 원문이 준 칸은 **둘**이다 — 「현재 수준 · 강점과 약점」과 「권장 커리큘럼」.
 * 강점과 약점을 한 칸에 몰지 않는다: 원문이 둘을 한 줄에 적었어도 표(`diag`)는
 * `strengths`·`weaknesses` 로 갈라 두었고, 갈라 두면 나중에 「약점만 모아 보기」가 된다.
 *
 * **글자 수 하한을 두지 않는다.** 원문은 일반·그룹 리포트에만 하한(30자↑·60자↑)을 적었고
 * 진단에는 안 적었다. 없는 규칙을 만들면 그 순간 원문에 없는 거절이 생긴다 (D-R44).
 */
export class TeacherDiagCreateDto {
  @ApiProperty({ description: '누구의 진단인가 — 서버가 내 담당 학생인지 다시 본다' })
  @IsInt() @Min(1) studentId!: number;

  @ApiProperty({ description: '현재 수준 — 원문 「현재 수준 · 강점과 약점」의 첫 줄', maxLength: 2000 })
  @IsString() @MaxLength(2000) levelSummary!: string;

  @ApiPropertyOptional({ description: '강점', maxLength: 2000 })
  @IsOptional() @IsString() @MaxLength(2000) strengths?: string;

  @ApiPropertyOptional({ description: '약점', maxLength: 2000 })
  @IsOptional() @IsString() @MaxLength(2000) weaknesses?: string;

  @ApiPropertyOptional({ description: '권장 커리큘럼 — 원문 04 의 둘째 줄', maxLength: 2000 })
  @IsOptional() @IsString() @MaxLength(2000) curriculum?: string;

  @ApiPropertyOptional({ description: '어느 회차에서 봤는가 — 안 주면 null', type: Number, nullable: true })
  @IsOptional() @IsInt() @Min(1) serId?: number | null;
}

export class TeacherGuideStudentDto {
  @ApiProperty() studentId!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional(S) grade?: string | null;
  @ApiPropertyOptional(S) school?: string | null;
  @ApiPropertyOptional(S) targetExam?: string | null;
  @ApiPropertyOptional({ ...S, description: '지도 강도 — stu.guidance 원문 (미설정 null)' }) guidance?: string | null;
  @ApiPropertyOptional({ ...S, description: '수업 언어 — stu.lang 원문 (ko·en 등)' }) lang?: string | null;
  @ApiProperty({ description: '이번 주 내 수업 횟수 (취소 제외)' }) weekCount!: number;
  @ApiProperty({ type: [TeacherGuideLessonDto], description: '이번 주 내 수업 회차 (시각 순)' }) lessons!: TeacherGuideLessonDto[];
  @ApiProperty({ type: [TeacherGuideBookDto], description: '교재 — 사용 중 먼저, 반환분은 이력' }) books!: TeacherGuideBookDto[];
  @ApiPropertyOptional({ type: TeacherGuideDiagDto, nullable: true, description: '최신 진단 — 없으면 null' })
  diag?: TeacherGuideDiagDto | null;
  @ApiProperty({ type: [TeacherGuideNoteDto], description: '인수인계 메모 — 관리자 · 매니저가 적은 줄, 최근 것부터 (N-36 ② · 강사 원문 27 · 44 「이전 강사 인수인계」 · 학부모에게 나가지 않는다)' })
  notes!: TeacherGuideNoteDto[];
}

export class TeacherGuidesQueryDto {
  @ApiPropertyOptional({ description: '조회할 주의 아무 날짜 YYYY-MM-DD — 없으면 오늘(KST) 주' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'week는 YYYY-MM-DD 형식입니다' })
  week?: string;
}

/** GET /teacher/guides — 이번 주 담당 학생과 수업 준비 정보 (강사 전용, 서버가 본인 수업으로 고정) */
export class TeacherGuidesDto {
  @ApiProperty({ description: '이번 주 월요일 YYYY-MM-DD (KST)' }) weekFrom!: string;
  @ApiProperty({ description: '이번 주 일요일 YYYY-MM-DD (KST)' }) weekTo!: string;
  @ApiProperty({ type: [TeacherGuideStudentDto], description: '첫 수업 시각 순' }) students!: TeacherGuideStudentDto[];
}

/** GET /teacher/history — 월 수업 기록 + 본인 정산 (덱 §29~31 · 강사 전용) */
export class TeacherHistoryDto {
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty({ type: TeacherHistoryStatsDto }) stats!: TeacherHistoryStatsDto;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '현재 적용 시급 — 본인만' }) wageRate?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 시급 적용 시작일' }) wageFrom?: string | null;
  @ApiProperty({ type: [TeacherHistoryLessonDto], description: '최근 날짜·이른 시각 순 — 보정 줄(settle=correction)은 이 달 정산에 얹힌 앞선 달 회차' }) lessons!: TeacherHistoryLessonDto[];
  @ApiProperty({ type: TeacherSettlementDto }) settlement!: TeacherSettlementDto;
  @ApiProperty({ type: [TeacherBonusRuleDto], description: '오늘 걸린 가산 규칙 — 대표 정리 · 기준 탭의 칸 그대로 (N-93)' }) bonusRules!: TeacherBonusRuleDto[];
}

/* ══ 불가 시간 (강사 원본 §15/16 · N-20 채택 2026-09-12 §4-17: 날짜별 7일 전 마감) ══ */

export class TeacherUnavBlockDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: '등록 날짜 YYYY-MM-DD (KST) — 판정 기준 (N-20)' }) onDate!: string;
  @ApiProperty({ description: '0=일 … 6=토 — onDate 에서 파생' }) dow!: number;
  @ApiProperty({ description: 'KST 분 (480=08:00)' }) startMin!: number;
  @ApiProperty({ description: 'KST 분 (1380=23:00)' }) endMin!: number;
  @ApiProperty({ description: '사유 — 관리자가 조정 가능성을 판단한다 (v26 필수)' }) reason!: string;
  @ApiProperty({ description: '마감 전(onDate ≥ 오늘+7)이면 삭제 가능 — 서버 판정' }) canDelete!: boolean;
}

export class TeacherUnavCycleDto {
  @ApiProperty({ description: '입사일 기준 N번째 2주 (1부터) — 표시/묶음용 (§4-17)' }) index!: number;
  @ApiProperty({ description: '회차 시작 YYYY-MM-DD' }) from!: string;
  @ApiProperty({ description: '회차 끝(14일째) YYYY-MM-DD' }) to!: string;
  @ApiProperty({ description: '입사일 — 회차 기준점 (원본 §15)' }) hiredOn!: string;
}

export class TeacherUnavQueryDto {
  @ApiPropertyOptional({ description: '조회할 2주 회차 안의 아무 날짜 YYYY-MM-DD — 없으면 오늘(KST)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'anchor는 YYYY-MM-DD 형식입니다' })
  anchor?: string;
}

export class TeacherUnavCreateDto {
  @ApiProperty({ description: '등록 날짜 YYYY-MM-DD — 오늘(KST)+7일 이후만 (N-20 날짜별 마감)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'onDate는 YYYY-MM-DD 형식입니다' })
  onDate!: string;
  @ApiProperty({ description: '시작 분 — 격자 08:00(480)~22:50' })
  @IsInt() @Min(480) @Max(1370)
  startMin!: number;
  @ApiProperty({ description: '끝 분 — 08:10(490)~23:00(1380), 시작보다 커야 한다' })
  @IsInt() @Min(490) @Max(1380)
  endMin!: number;
  @ApiProperty({ description: '사유 1~500자 — 필수. 관리자가 조정 가능성을 판단한다 (v26)' })
  @IsString()
  @MinLength(1, { message: '사유를 적어 주세요' })
  @MaxLength(500, { message: '사유는 500자 이내입니다' })
  reason!: string;
}

/** GET /teacher/unavailable — 2주 격자 메타 + 내 등록 (강사 전용, 서버가 본인 고정) */
export class TeacherUnavDto {
  @ApiProperty({ type: TeacherUnavCycleDto }) cycle!: TeacherUnavCycleDto;
  @ApiProperty({ description: '오늘 (KST)' }) today!: string;
  @ApiProperty({ description: '등록이 열리는 첫 날짜 = max(회차 시작, 오늘+7). 회차 끝을 넘으면 이 회차 전체가 마감' }) openFrom!: string;
  @ApiProperty({ description: '회차 14일 중 잠긴 날짜 수' }) lockedDays!: number;
  @ApiProperty({ description: '회차 14일 중 열린 날짜 수' }) openDays!: number;
  @ApiProperty({ type: [TeacherUnavBlockDto], description: '회차 안 내 등록 — 날짜·시각 순. 날짜 미상(legacy) 행은 싣지 않는다' })
  blocks!: TeacherUnavBlockDto[];
}

/* ══ 강사 머리줄 (강사 덱 모든 화면의 머리줄 · 메뉴 사용자 칸) ═══════════════ */

/** 내게 온 알림 한 줄 — 서랍 §16 과 같은 NOTI 행이지만 **받는 사람이 나인 것만** 싣는다 (N-26 · D-R44) */
export class TeacherNotiDto {
  @ApiProperty() id!: number;
  @ApiPropertyOptional({ ...S, description: '굵은 제목 한 줄 — 옛 행은 null(화면은 본문을 한 줄로 그린다)' }) title?: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ ...S, description: '원본으로 가는 앱 경로 — 강사가 열 수 없는 경로면 화면이 이동하지 않는다' })
  link?: string | null;
  @ApiProperty() read!: boolean;
  @ApiProperty({ description: '받은 시각 YYYY-MM-DDTHH:MI:SS+09:00 (KST)' }) at!: string;
  @ApiProperty({ description: '종류 낱말 — lib/noti 한 곳(서랍 §16 칩과 같은 표)' }) categoryLabel!: string;
  @ApiPropertyOptional({ ...S, description: '보낸 사람 — 시스템이 보낸 것은 null' }) fromName?: string | null;
}

/** GET /teacher/shell — 머리줄 「◷ 시간대 · ₩ 시급 · 🔔 알림」과 메뉴 사용자 칸 (강사 전용, 서버가 본인 고정) */
export class TeacherShellDto {
  @ApiProperty({ description: 'IANA 시간대 — staff.tz' }) timezone!: string;
  @ApiProperty({ description: '표기 「Seoul · UTC+9」 — 그 시각의 UTC 차이(서머타임 반영)를 서버가 짓는다' }) tzLabel!: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '오늘 적용되는 본인 시급(원/시간) — 없으면 null' })
  wageRate?: number | null;
  @ApiProperty({ type: [TeacherNotiDto], description: '내게 온 알림 — 최근 notiWindowDays 일, 안 읽은 것 먼저·새것 먼저' })
  notis!: TeacherNotiDto[];
  @ApiProperty({ description: '배지 수 — notis 중 안 읽은 줄 수' }) unread!: number;
  @ApiProperty({ description: '목록 창(일) — 창 밖 알림은 지우지 않고 싣지 않는다 (N-7)' }) notiWindowDays!: number;
}
