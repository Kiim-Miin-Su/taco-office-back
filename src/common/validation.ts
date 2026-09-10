/** @file-guide
 * 목적: validation.ts — IsCalendarDate (dto)
 * 책임/재사용: 프론트 CRUD 입력/응답을 Swagger와 validator로 명시한다. DB entity를 직접 반환하거나 UI 임시 상태를 영속 필드로 만들지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { ValidateBy, type ValidationOptions } from 'class-validator';
import { isIsoDate } from '../lib/kst';

/** @IsOptional과 함께 쓰면 명시적으로 nullable인 날짜도 같은 판정을 공유한다. */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isCalendarDate',
    validator: {
      validate: isIsoDate,
      defaultMessage: args => `${args?.property ?? 'date'}는 실제 YYYY-MM-DD 날짜여야 합니다`,
    },
  }, options);
}
