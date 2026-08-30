import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
// 요청 종류의 낱말은 lib/approval.ts 한 곳에서만 나온다 —
// 여기서 다시 적었다가 DB(time_move)·읽기 DTO(time)·쓰기 검증(off)이 세 벌로 갈렸다
import { CHREQ_TYPES, REQ_TYPE_LABEL } from '../../lib/approval';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/** §14 · §75 결재 한 줄 — 다섯 갈래가 같은 모양으로 온다 (D-R26) */
export class ApRowDto {
  @ApiProperty({ enum: ['rpt', 'plan', 'req', 'chreq', 'gpapack'] }) kind!: string;
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) sub?: string | null;
  @ApiPropertyOptional(N) byId?: number | null;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['waiting', 'back', 'done'] }) state!: string;
  @ApiPropertyOptional({ ...S, description: '반려면 반드시 있다 (D-R13)' }) why?: string | null;
  @ApiProperty({ description: '누르면 갈 곳 — 오버레이에서 승인하지 않는다 (D-R27)' }) go!: string;
}

export class ApFlowDto {
  @ApiProperty({ type: [ApRowDto], description: '되돌아온 것 — 맨 위 (§75)' }) back!: ApRowDto[];
  @ApiProperty({ type: [ApRowDto], description: '기다리는 것' }) waiting!: ApRowDto[];
  @ApiProperty({ type: [ApRowDto], description: '내가 올린 것' }) mine!: ApRowDto[];
  @ApiProperty({ description: '배지 숫자 — 손이 가야 하는 것만 센다' }) count!: number;
  @ApiProperty({ type: [String], description: '아직 표가 없어 못 세는 갈래 (N-13 대기)' })
  missingKinds!: string[];
}

/** §15 할 일 */
export class DrawerTodoDto {
  @ApiProperty() id!: number;
  @ApiProperty() title!: string;
  @ApiPropertyOptional(S) fromName?: string | null;
  @ApiPropertyOptional(S) toName?: string | null;
  @ApiPropertyOptional(N) fromId?: number | null;
  @ApiPropertyOptional(N) toId?: number | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() done!: boolean;
  @ApiProperty({ enum: ['meeting', 'complaint', 'consulting', 'plan', 'manual'] }) src!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
  @ApiPropertyOptional({ ...S, description: '출처가 있으면 원본으로 갈 곳' }) go?: string | null;
}

/** §16 알림 */
export class NotiDto {
  @ApiProperty() id!: number;
  @ApiProperty() body!: string;
  @ApiPropertyOptional(S) fromName?: string | null;
  @ApiPropertyOptional(N) toId?: number | null;
  @ApiPropertyOptional(S) link?: string | null;
  @ApiProperty() read!: boolean;
  @ApiProperty() at!: string;
  @ApiProperty({
    enum: ['alarm', 'ok', 'warn'],
    description: '표에 색 컬럼이 없어 링크로 파생한다 — lib/noti.ts 한 곳에서만',
  })
  tone!: string;
}

/** §17 구성원 · 시간대 */
export class MemberDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['teacher', 'manager', 'admin', 'ceo'] }) role!: string;
  @ApiPropertyOptional({ ...S, description: '직함은 권한이 아니다 (D-R39)' }) title?: string | null;
  @ApiPropertyOptional(S) tz?: string | null;
  @ApiProperty() active!: boolean;
}

export class TzGroupDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() tz!: string;
}

/** §18 프로그램 · 과목 */
export class KindRowDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty() color!: string;
  @ApiProperty({ description: '정원' }) cap!: number;
  @ApiProperty({ enum: ['lesson', 'intake', 'meeting'] }) grp!: string;
  @ApiProperty({ description: 'true 인 종류만 리포트 대상 (D-R6)' }) rep!: boolean;
}

/** §20 변경 요청 이력 */
export class ChangeReqDto {
  @ApiProperty() id!: number;
  @ApiProperty({ enum: Object.keys(REQ_TYPE_LABEL) }) reqType!: string;
  @ApiPropertyOptional(N) serId?: number | null;
  @ApiPropertyOptional(S) onDate?: string | null;
  @ApiPropertyOptional(S) reason?: string | null;
  @ApiProperty() state!: string;
  @ApiPropertyOptional(S) byName?: string | null;
  @ApiProperty({ description: '정기 수업이면 이후 전체 적용' }) applyAll!: boolean;
  @ApiProperty() at!: string;
}

/** §21 줌 계정 — 로그인 정보는 **절대 내려보내지 않는다** */
export class ZoomAccountDto {
  @ApiProperty() id!: number;
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ ...S, description: '학생 참가 링크. 로그인 정보와 같은 화면에 두지 않는다' })
  joinUrl?: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ description: '이 계정이 잡고 있는 회차 수' }) assigned!: number;
  @ApiProperty({ description: '같은 시간에 두 수업에 배정된 건수 — 0이어야 한다' }) overlaps!: number;
}

/** 서랍 하나가 여덟 칸을 함께 내려준다 — 열 때마다 여덟 번 왕복하지 않는다 */
export class DrawerDto {
  @ApiProperty({ type: ApFlowDto, description: '§14 승인 대기함' }) approvals!: ApFlowDto;
  @ApiProperty({ type: [DrawerTodoDto], description: '§15 할 일' }) todos!: DrawerTodoDto[];
  @ApiProperty({ type: [NotiDto], description: '§16 알림' }) notis!: NotiDto[];
  @ApiProperty({ type: [MemberDto], description: '§17 구성원' }) members!: MemberDto[];
  @ApiProperty({ type: [TzGroupDto], description: '§17 시간대 그룹' }) tzGroups!: TzGroupDto[];
  @ApiProperty({ type: [KindRowDto], description: '§18 수업 종류' }) kinds!: KindRowDto[];
  @ApiProperty({ type: [ChangeReqDto], description: '§20 변경 요청' }) changeReqs!: ChangeReqDto[];
  @ApiProperty({ type: [ZoomAccountDto], description: '§21 줌 계정' }) zoomAccounts!: ZoomAccountDto[];
  @ApiProperty({ description: '관리자 화면의 모든 시각은 KST 다 (D-R12)' }) tz!: string;
}

/* ══ 쓰기 ═══════════════════════════════════════════════════════════════
   서랍에서 하는 것은 **넣기와 표시뿐**이다. 승인·반려는 그 화면에서 한다 (D-R27). */


export class TodoDoneDto {
  @ApiProperty({ description: '완료로 바꿀지 여부' })
  @IsBoolean()
  done!: boolean;
}

/** §19 변경 요청 넣기 */
export class ChangeReqCreateDto {
  @ApiProperty({ enum: CHREQ_TYPES, description: '수업을 바꿔 달라는 요청의 종류' })
  @IsIn(CHREQ_TYPES)
  reqType!: (typeof CHREQ_TYPES)[number];

  @ApiPropertyOptional({ description: '어느 수업인지' })
  @IsOptional() @IsInt() @Min(1)
  serId?: number;

  @ApiPropertyOptional({ example: '2026-09-01', description: '어느 날짜인지' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  onDate?: string;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: true,
    description: '바꾸려는 내용 — 종류에 따라 startMin · endMin · teacherId · roomId · zaccId',
  })
  @IsOptional()
  payload?: Record<string, unknown>;

  @ApiProperty({ description: '사유는 비워 둘 수 없다 (D-R13 과 같은 이유)' })
  @IsString() @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: '정기 수업이면 이후 전체 적용 (D-R16)' })
  @IsOptional() @IsBoolean()
  applyAll?: boolean;
}

/** §19 겹침 미리보기 한 줄 — 막는 것은 DB, 설명은 이것 */
export class ConflictRowDto {
  @ApiProperty() serId!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty() startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiPropertyOptional(S) title?: string | null;
  @ApiProperty({ enum: ['teacher', 'room', 'zoom'], description: '무엇이 겹치는가' }) with!: string;
  @ApiPropertyOptional({ ...S, description: '누구와 겹치는가 — 이름을 보여 준다' }) whoName?: string | null;
}

export class ChangeReqResultDto {
  @ApiPropertyOptional({ ...N, description: '만들어진 요청 id. 겹쳐서 막혔으면 없다' }) id?: number | null;
  @ApiProperty({ type: [ConflictRowDto], description: '비어 있지 않으면 제출이 막힌 것이다' })
  conflicts!: ConflictRowDto[];
}
