/** @file-guide
 * 목적: teacher-change.dto.ts — TeacherChangeDto, TeacherChangeResultDto, TcStepDto 등 (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 교체 마법사 — 테스트 시나리오 J-97 「강사 교체 요구 — 6단계」 · D-46 「강사 퇴사 — 담당 전체 이관」 ·
 * N-132 「강사가 당일 아침 못 나옴 — 대강 일괄 + 안내」 · D-45 「하루만 대강」 · F-62 「강사 교체 시 간이 안내」 (C93).
 *
 * 화면이 보내는 것은 **원래 강사 · 새 강사 · 범위(하루만 / 이 날부터) · 날짜 · (고른 수업 · 학생 · 컴플레인)**뿐이다.
 * 여섯 단계(스케줄 · 안내 초안 · 학부모 안내 · 교재 확인 · 정산 시수 · 선생님 전달)는 서버가 **한 트랜잭션**에서 기존 쓰기를
 * 순서대로 부르고 단계마다의 결과를 `steps` 로 돌려준다 — 화면은 체크를 세지 않는다(D-R37). 미리보기는 같은 트랜잭션을 되돌린다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsHash, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { DATE_SCHEMA, IsCalendarDate } from '../../common/validation';
import { UnavWarnDto } from '../schedule/schedule.dto';

const ID_MAX = Number.MAX_SAFE_INTEGER;
export const TEACHER_CHANGE_MODES = ['day', 'from'] as const;
export type TeacherChangeMode = (typeof TEACHER_CHANGE_MODES)[number];
export const TEACHER_CHANGE_SCOPES = ['student_classes', 'whole_class'] as const;
export type TeacherChangeScope = (typeof TEACHER_CHANGE_SCOPES)[number];

export class TeacherChangeDto {
  @ApiProperty({ description: '원래 강사 (STAFF) — 퇴사한 강사면 비활성이어도 된다' })
  @IsInt() @Min(1) @Max(ID_MAX) fromTeacherId!: number;

  @ApiProperty({ description: '새 강사 (STAFF · 활성) — 자습 감독처럼 강사 역할이 아니어도 맡을 수 있다 (C74)' })
  @IsInt() @Min(1) @Max(ID_MAX) toTeacherId!: number;

  @ApiProperty({ enum: TEACHER_CHANGE_MODES, description: 'day = 그날만 대강(회차 예외 · N-132 · D-45) · from = 이 날부터 계속(규칙을 가른다 · D-R16 · D-46 · J-97)' })
  @IsIn(TEACHER_CHANGE_MODES) mode!: TeacherChangeMode;

  @ApiProperty({ ...DATE_SCHEMA, description: '대강 날짜 / 시작일' })
  @IsCalendarDate() date!: string;

  @ApiPropertyOptional({ type: [Number], description: '대상 수업(규칙) — 비우면 그 강사의 그날/그 뒤 전부. 미리보기의 series 에서 고른다' })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true }) @Max(ID_MAX, { each: true })
  serIds?: number[];

  @ApiPropertyOptional({ description: '이 학생의 수업만 (컴플레인에서 온 교체 · J-97) — 컴플레인에 학생이 있으면 그 학생으로 **고정**되고, 다른 학생을 함께 보내면 400 CPL_STUDENT_MISMATCH (CR-BE-02)' })
  @IsOptional() @IsInt() @Min(1) @Max(ID_MAX) studentId?: number;

  @ApiPropertyOptional({ description: '컴플레인 — 있으면 `cpl.teacher_changed` 를 세우고 접수 건은 대응으로 옮긴다' })
  @IsOptional() @IsInt() @Min(1) @Max(ID_MAX) cplId?: number;

  @ApiPropertyOptional({ maxLength: 300, description: '알림·안내에 실을 한 줄' })
  @IsOptional() @IsString() @MaxLength(300) memo?: string;

  @ApiPropertyOptional({ enum: TEACHER_CHANGE_SCOPES, description: '그룹 수업 apply는 preview와 같은 명단을 확인한 whole_class가 필수다.' })
  @IsOptional() @IsIn(TEACHER_CHANGE_SCOPES) scope?: TeacherChangeScope;

  @ApiPropertyOptional({ format: 'uuid', description: 'apply 멱등 키. preview에는 보내지 않는다.' })
  @IsOptional() @IsUUID('4') requestKey?: string;

  @ApiPropertyOptional({ minLength: 64, maxLength: 64, description: 'preview가 돌려준 대상·명단·자산 상태 버전' })
  @IsOptional() @IsHash('sha256') expectedVersion?: string;
}

export class TeacherChangeUndoDto {
  @ApiProperty({ minimum: 1, description: '적용 결과의 rowVersion' })
  @IsInt() @Min(1) expectedVersion!: number;
}

export class TcActorDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
}

export class TcAssetCountsDto {
  @ApiProperty() series!: number;
  @ApiProperty() occurrences!: number;
  @ApiProperty() guideDrafts!: number;
  @ApiProperty() parentNotices!: number;
  @ApiProperty() books!: number;
  @ApiProperty() notifications!: number;
  @ApiProperty() complaints!: number;
}

export class TcStaffDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '활성인가 — 퇴사한 강사에게는 알림을 보내지 않는다' }) active!: boolean;
}

export class TcSeriesDto {
  @ApiProperty({ description: '원래 규칙' }) serId!: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'from 이면 갈라진 새 규칙 (D-R16) · day 면 null' }) newSerId!: number | null;
  @ApiProperty() title!: string;
  @ApiProperty() kindName!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subName!: string | null;
  @ApiProperty() ruleLabel!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty({ type: [String], description: '그 날짜의 명단' }) students!: string[];
  @ApiProperty({ description: '옮긴 회차 수 (day 면 1)' }) occurrences!: number;
  @ApiProperty({ description: '첫 바뀐 회차 날짜' }) firstOn!: string;
}

export class TcBookDto {
  @ApiProperty({ description: '이관 전 교재 담당 강사 (STAFF)' }) previousTeacherId!: number;
  @ApiProperty() previousTeacherName!: string;
  @ApiProperty({ description: '작업 뒤 교재 담당 강사 — from이면 새 강사, day면 이전 강사 유지 (STAFF)' }) teacherId!: number;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ description: '교체 시작일에 실제 명단에 있는 학생 (STU)' }) studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiProperty({ description: '이어받을 배부 행 (ISSUE)' }) issueId!: number;
  @ApiProperty({ description: '배부된 교재 (LIB)' }) libId!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'ISSUE 활성 상태 — wait | auto | ok' }) state!: string;
  @ApiProperty({ description: 'from 영구 교체로 담당을 이관하는가 — day 하루 대강은 false' }) transferred!: boolean;
}

export class TcPayoutMonthDto {
  @ApiProperty() month!: string;
  @ApiProperty({ description: '그 달에 새 강사로 옮겨 간 회차' }) occurrences!: number;
  @ApiProperty({ description: '원래 강사의 그 달 정산이 이미 확정됐다 (N-51 — 되돌리지 않는다)' }) fromConfirmed!: boolean;
  @ApiProperty({ description: '새 강사의 그 달 정산이 이미 확정됐다 (N-51)' }) toConfirmed!: boolean;
}

export class TcStepDto {
  @ApiProperty({ enum: ['schedule', 'guide', 'parent', 'book', 'payout', 'notify'] }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: '그 단계가 만든/확인한 것의 수' }) count!: number;
  @ApiProperty({ description: '한 줄 — 낱말은 서버 (D-R18)' }) note!: string;
}

export class TcComplaintDto {
  @ApiProperty() id!: number;
  @ApiProperty() stage!: string;
  @ApiProperty() teacherChanged!: boolean;
}

export class TeacherChangeResultDto {
  @ApiProperty({ description: 'true 면 되돌린 미리보기' }) preview!: boolean;
  @ApiProperty({ enum: TEACHER_CHANGE_MODES }) mode!: TeacherChangeMode;
  @ApiProperty() date!: string;
  @ApiProperty({ type: TcStaffDto }) fromTeacher!: TcStaffDto;
  @ApiProperty({ type: TcStaffDto }) toTeacher!: TcStaffDto;
  @ApiProperty({ type: [TcSeriesDto] }) series!: TcSeriesDto[];
  @ApiProperty({ description: '옮긴 회차 합' }) occurrences!: number;
  @ApiProperty({ description: '강사 교체 안내 초안 (GUIDE · F-62)' }) guideDrafts!: number;
  @ApiProperty({ description: '학부모 안내 행 (PNOTI · 보낼 것 · 발송처는 N-42)' }) parentNotices!: number;
  @ApiProperty({ type: [TcBookDto], description: '이전 강사 소유 교재 배정 — from은 새 강사에게 이관, day는 소유자 유지' }) books!: TcBookDto[];
  @ApiProperty({ type: [TcPayoutMonthDto], description: '달마다 옮겨 간 회차 — 정산은 회차를 읽으므로 저절로 따라온다 (lib/payout-sheet)' }) payout!: TcPayoutMonthDto[];
  @ApiProperty() notifiedTeachers!: number;
  @ApiProperty() notifiedStaff!: number;
  @ApiProperty({ type: [UnavWarnDto], description: '새 강사의 불가 시간에 걸치는 회차 — 막지 않고 알린다 (A-07)' }) unavailable!: UnavWarnDto[];
  @ApiPropertyOptional({ type: TcComplaintDto, nullable: true }) cpl!: TcComplaintDto | null;
  @ApiProperty({ type: [TcStepDto], description: '여섯 단계의 결과 — 화면은 이 목록을 체크로 그린다' }) steps!: TcStepDto[];
  @ApiProperty({ enum: TEACHER_CHANGE_SCOPES }) scope!: TeacherChangeScope;
  @ApiProperty({ description: '학생 기준 대상 중 그룹 수업이 있어 apply에 whole_class가 필요한가' }) requiresWholeClass!: boolean;
  @ApiProperty({ minLength: 64, maxLength: 64, description: 'apply의 expectedVersion으로 그대로 보내는 불투명 상태 버전' }) version!: string;
  @ApiProperty({ type: TcActorDto, description: '실제 HTTP actor' }) actor!: TcActorDto;
  @ApiProperty({ type: TcAssetCountsDto }) assets!: TcAssetCountsDto;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true, description: 'apply 멱등 키. preview는 null' }) requestKey!: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '적용 작업 원장의 version. preview는 null' }) rowVersion!: number | null;
  @ApiProperty({ description: '현재 결과를 실행 취소할 수 있는가' }) undoAvailable!: boolean;
}

export class TeacherChangeUndoResultDto {
  @ApiProperty({ format: 'uuid' }) requestKey!: string;
  @ApiProperty() rowVersion!: number;
  @ApiProperty({ enum: ['undone'] }) state!: 'undone';
  @ApiProperty({ type: TcActorDto }) actor!: TcActorDto;
  @ApiProperty({ format: 'date-time' }) undoneAt!: string;
}
