/** @file-guide
 * 목적: teacher.dto.ts — TeacherLessonDto, TeacherWeekDto, TeacherTodoDto, TeacherSettingsDto, TeacherHomeDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
