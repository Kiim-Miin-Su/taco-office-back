/** @file-guide
 * 목적: guides.dto.ts — GuideDto, PerLessonNoticeDto, GuidesDto (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

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
  /** 「보내야 함」의 정본 — 서버 GUIDE_PENDING_DB 파생. 화면은 상태 목록을 다시 정의하지 않는다. */
  @ApiProperty({ description: '아직 안 보냄 (GUIDE_PENDING_DB 파생) — 화면은 이 값만 읽는다' }) pending!: boolean;
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

/**
 * §43 머리의 「문구 관리」 — 안내를 쓸 때 꺼내 쓰는 **문구 틀**(GTPL).
 *
 * 틀은 안내와 **끊어져 있다.** 안내를 만들 때 본문을 복사해 넣고, 그 뒤로 틀을 고쳐도
 * 이미 쓴 안내는 안 바뀐다 — 보낸 말이 나중에 달라지면 안 되기 때문이다.
 * (`guide` 에 `gtpl_id` 가 없는 것이 그 뜻이다.)
 */
export class GuideTemplateDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiProperty() body!: string;
}

export class GuideTemplateWriteDto {
  @ApiProperty({ description: '무엇에 쓰는 틀인지 — 목록에서 이 이름으로 고른다' })
  @IsString() @MinLength(1) @MaxLength(40) name!: string;

  @ApiProperty({ description: '문구 본문' })
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

/**
 * §43 「안내 작성」 — 본문을 채우면 **보낼 준비**가 된다.
 *
 * 상태 낱말을 화면이 보내지 않는다. 「썼다」는 사실만 서버에 주고, 그 결과 어느 상태가 되는지는
 * 서버가 정한다 (D-R18) — 화면이 `'ready'` 를 적어 보내면 낱말이 두 곳에 살게 된다.
 */
export class GuideBodyDto {
  @ApiProperty({ description: '안내 본문' })
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}
