/** @file-guide
 * 목적: teacher.dto.ts — TeacherHomeDto(홈)·TeacherHistoryDto(수업 히스토리·정산) 계열 강사 표면 DTO (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { REP_STATE_T_VALUES } from '../../entities/enums';

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

/** GET /teacher/history — 월 수업 기록 + 본인 정산 (덱 §29~31 · 강사 전용) */
export class TeacherHistoryDto {
  @ApiProperty({ description: 'YYYY-MM' }) month!: string;
  @ApiProperty({ type: TeacherHistoryStatsDto }) stats!: TeacherHistoryStatsDto;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '현재 적용 시급 — 본인만' }) wageRate?: number | null;
  @ApiPropertyOptional({ ...S, description: '그 시급 적용 시작일' }) wageFrom?: string | null;
  @ApiProperty({ type: [TeacherHistoryLessonDto], description: '최근 날짜·이른 시각 순' }) lessons!: TeacherHistoryLessonDto[];
  @ApiProperty({ type: TeacherSettlementDto }) settlement!: TeacherSettlementDto;
}
