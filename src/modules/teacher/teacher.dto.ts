/** @file-guide
 * 목적: teacher.dto.ts — TeacherHomeDto(홈)·TeacherHistoryDto(수업 히스토리·정산) 계열 강사 표면 DTO (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { REP_STATE_T_VALUES, SUG_CAT_T_VALUES, SUG_STATE_T_VALUES } from '../../entities/enums';

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
  @ApiProperty({ enum: [...REP_STATE_T_VALUES], description: '리포트 상태 — rep 행이 없으면 none' })
  repState!: string;
}

export class TeacherWeekDto {
  @ApiProperty({ description: '이번 주(월~일) 취소 제외 수업 수' }) lessons!: number;
  @ApiProperty({ description: '이번 주 총 시수(분)' }) minutes!: number;
  @ApiProperty({ description: '이번 주 지나간 수업 중 미작성 후보 수' }) unwritten!: number;
}

/** 홈 우측 「오늘 할 일」 — 판정은 전부 서버. 화면은 숫자만 읽는다. */
export class TeacherTodoDto {
  @ApiProperty({ description: '지나간 수업 중 리포트 미작성 후보 (REPORT_UNWRITTEN_CANDIDATE_DB)' }) unwrittenReports!: number;
  @ApiProperty({ description: '승인 대기(wait) 리포트' }) waitingApprovals!: number;
  @ApiProperty({ description: '진행 중(pending) 스케줄 변경 요청' }) openChangeRequests!: number;
  @ApiProperty({ description: '진행 중(pending) 내 요청 — 시급 변경·불가 시간 등(req)' }) openStaffRequests!: number;
}

export class TeacherSettingsDto {
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'IANA 시간대 — staff.tz' }) timezone!: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '현재 적용 시급(원/시간) — 본인만 조회' })
  wageRate?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 시급 적용 시작일' }) wageFrom?: string | null;
}

/** GET /teacher/home — 강사 홈 한 번에 (덱 §7~9 · 강사 전용, 서버가 본인으로 고정) */
export class TeacherHomeDto {
  @ApiProperty({ description: '기준일 YYYY-MM-DD (KST 오늘)' }) todayDate!: string;
  @ApiProperty({ type: [TeacherLessonDto], description: '오늘 수업 (시각 순)' }) today!: TeacherLessonDto[];
  @ApiProperty({ type: [TeacherLessonDto], description: '내일부터 7일' }) upcoming!: TeacherLessonDto[];
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
  @ApiPropertyOptional({ type: Number, nullable: true, description: '제출분 수업료 — 그 수업일 시급×시간, 정수 절사. 가산 정책 미확정으로 단일 시급 (경계 기록)' })
  pay?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '제출분 확정 지각 차감 (D-R32 — 최초 제출 기준)' })
  lateCut?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '종료 후 미제출분 — 지금 제출하면 붙는 차감 (D-R32)' })
  penaltyIfNow?: number | null;
}

export class TeacherHistoryStatsDto {
  @ApiProperty({ description: '종료된 수업 (취소 제외)' }) doneCount!: number;
  @ApiProperty() doneMinutes!: number;
  @ApiProperty({ description: '리포트 제출분 — 승인 여부는 보지 않는다 (D-R7)' }) writtenCount!: number;
  @ApiProperty() writtenMinutes!: number;
  @ApiProperty({ description: '종료 후 미작성' }) unwrittenCount!: number;
  @ApiProperty() unwrittenMinutes!: number;
}

/** 월 정산 — payout 행이 있으면 저장값(확정), 없으면 실시간 계산 (D-R24 · D-R7 · D-R32 · D-15). */
export class TeacherSettlementDto {
  @ApiProperty({ description: 'YYYY-MM' }) yearMonth!: string;
  @ApiProperty({ description: 'true면 payout 저장값, false면 실시간 계산' }) confirmed!: boolean;
  @ApiPropertyOptional({ ...S, description: 'payout.state — 확정 행이 있을 때만' }) state?: string | null;
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
  @ApiPropertyOptional(S) level?: string | null;
  @ApiProperty({ description: 'SE | TE' }) seTe!: string;
  @ApiProperty({ description: '배부일 YYYY-MM-DD' }) issuedOn!: string;
  @ApiPropertyOptional({ ...S, description: '반환일 — null 이면 사용 중' }) returnedOn?: string | null;
}

export class TeacherGuideDiagDto {
  @ApiPropertyOptional({ ...S, description: '응시일 YYYY-MM-DD' }) onDate?: string | null;
  @ApiProperty() levelSummary!: string;
  @ApiPropertyOptional(S) strengths?: string | null;
  @ApiPropertyOptional(S) weaknesses?: string | null;
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
  @ApiProperty({ type: [TeacherHistoryLessonDto], description: '최근 날짜·이른 시각 순' }) lessons!: TeacherHistoryLessonDto[];
  @ApiProperty({ type: TeacherSettlementDto }) settlement!: TeacherSettlementDto;
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
