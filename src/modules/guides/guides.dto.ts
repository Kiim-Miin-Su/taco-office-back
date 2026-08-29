import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const S = { type: String, nullable: true } as const;
const N = { type: Number, nullable: true } as const;

/**
 * §41 수업 안내 — **한 번만** 나가는 것.
 * 첫 수업 안내 · 강사 교체 안내가 여기다. 보냈으면 끝이다.
 */
export class GuideDto {
  @ApiProperty() id!: number;
  @ApiProperty({ description: 'new(첫 수업) | teacher_change(강사 교체)' }) reason!: string;
  @ApiProperty({ enum: ['draft', 'ready', 'sent', 'read'], description: 'draft·ready 가 아직 안 보낸 것' }) state!: string;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiPropertyOptional(S) teacherName?: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  @ApiPropertyOptional(S) body?: string | null;
  @ApiPropertyOptional(S) dueOn?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: '기한이 지난 날 수. 0이면 안 지남' }) overdueDays!: number;
}

/**
 * §42 회차 안내 — **매번** 나가는 것.
 * 온라인 수업의 줌 링크처럼 회차마다 다시 보내야 하는 것이 여기다.
 * 안내(GUIDE)와 섞으면 「한 번 보냈으니 됐다」가 되어 버린다.
 */
export class PerLessonNoticeDto {
  @ApiProperty() id!: number;
  @ApiProperty() onDate!: string;
  @ApiProperty({ enum: ['sms', 'kakao', 'email', 'app'] }) channel!: string;
  @ApiPropertyOptional(S) studentName?: string | null;
  @ApiPropertyOptional(S) serTitle?: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ ...S, description: '아직 안 보냈으면 null' }) sentAt?: string | null;
}

export class GuidesDto {
  @ApiProperty({ type: [GuideDto], description: '한 번만 나가는 안내' }) guides!: GuideDto[];
  @ApiProperty({ type: [PerLessonNoticeDto], description: '회차마다 나가는 안내' }) perLesson!: PerLessonNoticeDto[];
  @ApiProperty({ description: '아직 안 보낸 안내 수' }) todoCount!: number;
  @ApiPropertyOptional({ ...N, description: '강사면 자기 것만 본다 — 그 강사 id' }) scopedTeacherId?: number | null;
}
