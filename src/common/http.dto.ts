/** @file-guide
 * 목적: 여러 HTTP 경계에서 재사용하는 성공/오류 응답 형상.
 * 책임/재사용: 실제 응답 필드만 Swagger로 정의한다. 업무 payload·DB 컬럼을 이 DTO에 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { ApiProperty } from '@nestjs/swagger';

/** 본문이 있는 단순 성공 응답. 204 응답에는 사용하지 않는다. */
export class OkDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true;
}

/** ApiErrorFilter가 실제 노출하는 두 필드. 내부 오류/SQL 상세는 포함하지 않는다. */
export class ApiErrorDto {
  @ApiProperty({ description: '공용 오류 코드. HTTP status와 함께 판정한다.' })
  code!: string;

  @ApiProperty({ description: '공용 필터에서 정규화한 사용자 안내 문구.' })
  message!: string;
}
