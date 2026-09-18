/** @file-guide
 * 목적: meta.dto.ts — KindDto, SubDto, RoomDto, ZaccDto, StaffBriefDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 코드표 — 화면이 색과 이름을 여기서만 가져간다.
 * 프론트에 KIND/SUB 배열을 복사해 두면 명세서와 조용히 어긋난다 (D-R18).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ATTENDANCE_CANCEL_REASONS, CANCEL_TREATS, type AttendanceCancelReason, type CancelTreat } from '../../lib/rules';

export class KindDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '토큰과 같은 값 — 화면은 이 색을 쓰기만 한다' }) color!: string;
  @ApiProperty() cap!: number;
  @ApiProperty({ enum: ['lesson', 'intake', 'meeting'] }) grp!: string;
  @ApiProperty({ description: '리포트 대상인가 (D-4)' }) rep!: boolean;
}

export class SubDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
}

export class RoomDto {
  @ApiProperty() id!: number;
  @ApiProperty() branch!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) capacity?: number | null;
}

export class ZaccDto {
  @ApiProperty() id!: number;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) meetingId?: string | null;
}

export class StaffBriefDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['teacher', 'manager', 'admin', 'ceo'] }) role!: string;
  @ApiProperty({ description: '코디네이터·관리자 후보 판정. role을 화면에서 다시 비교하지 않는다' }) canAdminPage!: boolean;
  @ApiProperty({ description: '자료 요청 코디네이터 후보 판정. 개인별 권한 예외까지 반영한다' }) canGpaPack!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: '표시용 직함 — 권한과 무관하다 (D-R39)' }) title?: string | null;
}

export class StudentBriefDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) school?: string | null;
}

/**
 * 청구 종류 — 낱말은 서버가 만든다 (D-R18 · 대표 결정 2026-09-13 · N-37).
 *
 * 화면이 `<option value="tuition">수업료 청구</option>` 처럼 적고 있었다. 종류가 둘에서 넷으로
 * 늘던 날 그 자리가 바로 뒤처졌고, 다음에 또 늘면 같은 일이 다시 난다.
 * 코드표(`/meta`)가 이미 종류·과목·강의실을 내려보내고 있으니 여기에 실어 보낸다.
 */
export class InvTypeDto {
  @ApiProperty({ description: '저장되는 코드값' }) key!: string;
  @ApiProperty({ description: '이름 — §53 카드의 배지' }) label!: string;
  @ApiProperty({ description: '부제 — §57 「그 밖의 수입」 줄의 설명' }) sub!: string;
  @ApiProperty({ description: '수업료가 아닌 돈인가 — §57 이 세는 것' }) other!: boolean;
}

/**
 * 휴강 사유 한 줄 — §12 「휴강 · 수정」 창의 select (C92). 낱말과 **차감 가능 여부**를 서버가 준다.
 * 화면이 「학원 사정은 차감 불가」를 다시 판정하면 서버 정책과 갈린다 (D-R39).
 */
export class CancelReasonDto {
  // 코드값을 enum 으로 내려보낸다 — 생성 타입이 곧 휴강 DTO 의 입력 타입이 되어 화면이 캐스팅하지 않는다
  @ApiProperty({ enum: ATTENDANCE_CANCEL_REASONS, description: '저장되는 코드값 — ATT.reason 과 같은 다섯' })
  key!: AttendanceCancelReason;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '이 사유로 차감(소진) 처리를 고를 수 있는가 — 학생 결석만 true' }) deductible!: boolean;
}

export class CancelTreatDto {
  @ApiProperty({ enum: CANCEL_TREATS, description: 'carry | deduct | makeup' }) key!: CancelTreat;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '칸 아래 한 줄 — 무엇이 일어나는지' }) sub!: string;
}

export class MetaDto {
  @ApiProperty({ type: [KindDto] }) kinds!: KindDto[];
  @ApiProperty({ type: [SubDto] }) subs!: SubDto[];
  @ApiProperty({ type: [RoomDto] }) rooms!: RoomDto[];
  @ApiProperty({ type: [ZaccDto] }) zaccs!: ZaccDto[];
  @ApiProperty({ type: [StaffBriefDto] }) staff!: StaffBriefDto[];
  @ApiProperty({ type: [StudentBriefDto] }) students!: StudentBriefDto[];
  @ApiProperty({ type: [InvTypeDto], description: '청구 종류 넷 — 낱말은 서버가 만든다 (D-R18)' }) invTypes!: InvTypeDto[];
  @ApiProperty({ type: [CancelReasonDto], description: '휴강 사유 다섯과 차감 가능 여부 (C92)' }) cancelReasons!: CancelReasonDto[];
  @ApiProperty({ type: [CancelTreatDto], description: '휴강 처리 셋 — 이월 · 차감 · 보강 이관 (C92)' }) cancelTreats!: CancelTreatDto[];
}
