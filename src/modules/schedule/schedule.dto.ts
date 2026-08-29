/**
 * 스케줄 — 탭 01 의 여섯 화면(§07~§12)이 전부 이 한 모양을 쓴다.
 * 일간·주간·월간·학생별·선생님별이 다른 DTO 를 쓰면 색과 상태가 갈린다.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OccStudentDto {
  @ApiProperty() id!: number;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty({ description: '그날만 빠진 학생인가 (D-R21)' }) droppedOnce!: boolean;
}

export class OccurrenceDto {
  @ApiProperty({ description: '반복 규칙 id' }) serId!: number;
  @ApiProperty({ example: '2026-08-28' }) date!: string;
  @ApiProperty({ description: '자정부터 분' }) startMin!: number;
  @ApiProperty() endMin!: number;
  @ApiProperty() kindKey!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) teacherId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) teacherName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) roomId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) roomName?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) zaccId?: number | null;
  @ApiProperty({ enum: ['offline', 'online'] }) mode!: string;
  @ApiProperty() canceled!: boolean;
  @ApiProperty({ description: '이 회차에 예외가 붙었는가' }) hasException!: boolean;

  @ApiProperty({
    enum: ['na', 'plan', 'none', 'draft', 'wait', 'ok', 'rej'],
    description: '리포트 상태. 캘린더 블록 색이 이 값에서 나온다 (D-R7 · V26 §2.3)',
  })
  repState!: string;

  @ApiProperty({ description: '리포트를 썼는가 — 정산에 들어가는 조건 하나 (D-R7)' })
  written!: boolean;

  @ApiProperty({ type: [OccStudentDto] }) students!: OccStudentDto[];
}

export class OccurrenceListDto {
  @ApiProperty({ example: '2026-08-24' }) from!: string;
  @ApiProperty({ example: '2026-08-30' }) to!: string;
  @ApiProperty({ type: [OccurrenceDto] }) items!: OccurrenceDto[];
}
