/** @file-guide
 * 목적: country-timezone.entity.ts — COUNTRY_TIMEZONE 테이블 ORM 매핑 (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기 metadata를 함께 대조한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * COUNTRY_TIMEZONE — docs/contracts/db/erd.dbml v4.59 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'country_timezone' })
export class CountryTimezone {
  @PrimaryColumn({ type: 'char', length: 2 })
  countryCode: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  timezone: string;

  @Column({ type: 'varchar', length: 80 })
  labelKo: string;

  @Column({ type: 'boolean', default: false })
  isRepresentative: boolean;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
