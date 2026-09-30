/** @file-guide
 * 목적: ST1-b1 최초 국가·시간대·학년 사전의 버전 고정 값.
 * 책임/재사용: migration과 개발 seed가 같은 값만 삽입한다. 충돌하는 운영 표시명/활성 상태는 덮지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import type { QueryRunner } from 'typeorm';

/** 이 배열은 이미 적용된 migration의 일부다. 기존 값을 수정하려면 새 migration을 만든다. */
export const COUNTRY_V1 = [
  ['KR', '대한민국', 'South Korea', 'Asia/Seoul'],
  ['US', '미국', 'United States', 'America/New_York'],
  ['GB', '영국', 'United Kingdom', 'Europe/London'],
  ['CA', '캐나다', 'Canada', 'America/Toronto'],
  ['AU', '호주', 'Australia', 'Australia/Sydney'],
  ['NZ', '뉴질랜드', 'New Zealand', 'Pacific/Auckland'],
  ['SG', '싱가포르', 'Singapore', 'Asia/Singapore'],
  ['JP', '일본', 'Japan', 'Asia/Tokyo'],
  ['CN', '중국', 'China', 'Asia/Shanghai'],
  ['TW', '대만', 'Taiwan', 'Asia/Taipei'],
  ['HK', '홍콩', 'Hong Kong', 'Asia/Hong_Kong'],
  ['MY', '말레이시아', 'Malaysia', 'Asia/Kuala_Lumpur'],
  ['TH', '태국', 'Thailand', 'Asia/Bangkok'],
  ['VN', '베트남', 'Vietnam', 'Asia/Ho_Chi_Minh'],
  ['ID', '인도네시아', 'Indonesia', 'Asia/Jakarta'],
  ['PH', '필리핀', 'Philippines', 'Asia/Manila'],
  ['IN', '인도', 'India', 'Asia/Kolkata'],
  ['AE', '아랍에미리트', 'United Arab Emirates', 'Asia/Dubai'],
  ['SA', '사우디아라비아', 'Saudi Arabia', 'Asia/Riyadh'],
  ['DE', '독일', 'Germany', 'Europe/Berlin'],
  ['FR', '프랑스', 'France', 'Europe/Paris'],
  ['IT', '이탈리아', 'Italy', 'Europe/Rome'],
  ['ES', '스페인', 'Spain', 'Europe/Madrid'],
  ['NL', '네덜란드', 'Netherlands', 'Europe/Amsterdam'],
  ['CH', '스위스', 'Switzerland', 'Europe/Zurich'],
  ['IE', '아일랜드', 'Ireland', 'Europe/Dublin'],
  ['SE', '스웨덴', 'Sweden', 'Europe/Stockholm'],
  ['BR', '브라질', 'Brazil', 'America/Sao_Paulo'],
  ['MX', '멕시코', 'Mexico', 'America/Mexico_City'],
  ['ZA', '남아프리카공화국', 'South Africa', 'Africa/Johannesburg'],
] as const;

/** 대표 외 추가 선택지. 다중 시간대 국가에서 대표값을 사용자 선택으로 오인하지 않는다. */
export const ADDITIONAL_TIMEZONE_V1 = [
  ['US', 'America/Chicago', '미국 중부'],
  ['US', 'America/Los_Angeles', '미국 서부'],
  ['CA', 'America/Vancouver', '캐나다 서부'],
  ['AU', 'Australia/Perth', '호주 서부'],
  ['NZ', 'Pacific/Chatham', '뉴질랜드 채텀 제도'],
  ['ID', 'Asia/Makassar', '인도네시아 중부'],
  ['ID', 'Asia/Jayapura', '인도네시아 동부'],
  ['BR', 'America/Manaus', '브라질 아마조나스'],
  ['MX', 'America/Tijuana', '멕시코 북서부'],
] as const;

export const GRADE_CODES_V1 = {
  US: ['pre-kinder', 'kinder', ...Array.from({ length: 12 }, (_, i) => `G${i + 1}`), 'other'],
  GB: ['pre-kinder', 'kinder', ...Array.from({ length: 13 }, (_, i) => `Yr${i + 1}`), 'other'],
  KR: ['kinder', ...Array.from({ length: 6 }, (_, i) => `E${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `M${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `H${i + 1}`), 'other'],
  OTHER: ['repeat'],
} as const;

export interface CatalogSeedCounts { country: number; countryTimezone: number; educationGrade: number }

/** 기존 key는 이름·sort·active·대표 여부를 수정하지 않는다. 새 행만 채운다. */
export async function seedStudentCatalogV1(q: QueryRunner): Promise<CatalogSeedCounts> {
  let country = 0;
  let countryTimezone = 0;
  let educationGrade = 0;

  for (const [i, [code, nameKo, nameEn]] of COUNTRY_V1.entries()) {
    const rows = await q.query(
      `INSERT INTO country(code,name_ko,name_en,sort) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, nameKo, nameEn, i + 1],
    ) as unknown[];
    country += rows.length;
  }

  for (const [code, nameKo, , timezone] of COUNTRY_V1) {
    const rows = await q.query(
      `INSERT INTO country_timezone(country_code,timezone,label_ko,is_representative)
       SELECT $1,$2,$3, NOT EXISTS (
         SELECT 1 FROM country_timezone WHERE country_code=$1 AND active AND is_representative
       ) ON CONFLICT (country_code,timezone) DO NOTHING RETURNING country_code`,
      [code, timezone, `${nameKo} 대표`],
    ) as unknown[];
    countryTimezone += rows.length;
  }
  for (const [code, timezone, labelKo] of ADDITIONAL_TIMEZONE_V1) {
    const rows = await q.query(
      `INSERT INTO country_timezone(country_code,timezone,label_ko,is_representative)
       VALUES ($1,$2,$3,false) ON CONFLICT (country_code,timezone) DO NOTHING RETURNING country_code`,
      [code, timezone, labelKo],
    ) as unknown[];
    countryTimezone += rows.length;
  }

  const label = (system: string, code: string): string => {
    if (code === 'pre-kinder') return '프리킨더';
    if (code === 'kinder') return system === 'KR' ? '유치원생' : '킨더';
    if (code === 'other') return '기타';
    if (code === 'repeat') return 'N수생';
    if (system === 'KR') {
      const year = code.slice(1);
      return `${code[0] === 'E' ? '초' : code[0] === 'M' ? '중' : '고'}${year}`;
    }
    return code;
  };
  for (const [system, codes] of Object.entries(GRADE_CODES_V1)) {
    for (const [sort, code] of codes.entries()) {
      const rows = await q.query(
        `INSERT INTO education_grade(education_system,code,label_ko,sort)
         VALUES ($1,$2,$3,$4) ON CONFLICT (education_system,code) DO NOTHING RETURNING code`,
        [system, code, label(system, code), sort],
      ) as unknown[];
      educationGrade += rows.length;
    }
  }
  return { country, countryTimezone, educationGrade };
}
