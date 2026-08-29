/**
 * 코드표 — 화면이 색과 이름을 여기서만 가져간다.
 * 프론트에 KIND/SUB 배열을 복사해 두면 명세서와 조용히 어긋난다 (D-R18).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiPropertyOptional({ type: String, nullable: true, description: '표시용 직함 — 권한과 무관하다 (D-R39)' }) title?: string | null;
}

export class StudentBriefDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) school?: string | null;
}

export class MetaDto {
  @ApiProperty({ type: [KindDto] }) kinds!: KindDto[];
  @ApiProperty({ type: [SubDto] }) subs!: SubDto[];
  @ApiProperty({ type: [RoomDto] }) rooms!: RoomDto[];
  @ApiProperty({ type: [ZaccDto] }) zaccs!: ZaccDto[];
  @ApiProperty({ type: [StaffBriefDto] }) staff!: StaffBriefDto[];
  @ApiProperty({ type: [StudentBriefDto] }) students!: StudentBriefDto[];
}
