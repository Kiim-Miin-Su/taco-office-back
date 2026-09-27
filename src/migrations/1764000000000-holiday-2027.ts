/** @file-guide
 * 목적: 1764000000000-holiday-2027.ts — Holiday20271764000000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 공휴일 이름표 HOLIDAY 에 2027 년을 넣는다 (N-82 채택 ① 「해마다 데이터 migration」 · 대표 위임 2026-09-26 · W11).
 *
 * 표 · 이름 모양은 `1763100000000-schedule-holiday` 그대로다(키 (on_date, name) · 대체공휴일은 「광복절 대체」 모양).
 * 스키마 변경 0 · ERD 불변 — 데이터만 넣는다.
 *
 * **근거(웹 확인 2026-09-26):** 우주항공청 「2027년 월력요항」(2026-06 발표 — 관공서 공휴일 72일 · 3일 이상 연휴 10번)과
 * 2026-04-28 국무회의 의결 「관공서의 공휴일에 관한 규정」 개정(노동절 5.1 · 제헌절 7.17 을 **2026 년부터** 공휴일로 ·
 * 대체공휴일 적용). 부처님오신날 2027-05-13(목 · 음력 4.8)은 대체 없음. 2027 년에는 전국 선거일이 없다.
 *
 * **2026 년 두 줄도 여기서 채운다** — `1763100000000` 의 2026 목록은 개정 전에 쓰여 노동절(2026-05-01 금)과
 * 제헌절(2026-07-17 금)이 빠져 있다. 금요일이라 대체공휴일은 없다. 이미 적용된 migration 을 고치지 않고 새 줄로 더한다.
 *
 * 임시공휴일은 발표 때 한 벌씩 더한다(N-82 「매년 관보 확정 뒤 한 벌씩 · 임시공휴일은 발표 때 추가」).
 * `down` 은 이 파일이 넣은 (날짜, 이름) 줄만 지운다 — 표와 2026 목록은 그대로 둔다.
 */
export class Holiday20271764000000000 implements MigrationInterface {
  name = 'Holiday20271764000000000';

  /** 2026 년 개정으로 새로 공휴일이 된 두 날 (2026-04-28 국무회의 의결 · 금요일이라 대체 없음) */
  static readonly Y2026_ADDED: ReadonlyArray<readonly [string, string]> = [
    ['2026-05-01', '노동절'],
    ['2026-07-17', '제헌절'],
  ];

  /** 2027 대한민국 관공서 공휴일 — 일요일 외 24줄(우주항공청 「2027년 월력요항」: 일요일 52 + 24 = 76, 일요일과 겹친 넷을 빼 72) */
  static readonly Y2027: ReadonlyArray<readonly [string, string]> = [
    ['2027-01-01', '신정'],
    ['2027-02-06', '설날 연휴'],
    ['2027-02-07', '설날'],
    ['2027-02-08', '설날 연휴'],
    ['2027-02-09', '설날 대체'],
    ['2027-03-01', '삼일절'],
    ['2027-05-01', '노동절'],
    ['2027-05-03', '노동절 대체'],
    ['2027-05-05', '어린이날'],
    ['2027-05-13', '부처님오신날'],
    ['2027-06-06', '현충일'],
    ['2027-07-17', '제헌절'],
    ['2027-07-19', '제헌절 대체'],
    ['2027-08-15', '광복절'],
    ['2027-08-16', '광복절 대체'],
    ['2027-09-14', '추석 연휴'],
    ['2027-09-15', '추석'],
    ['2027-09-16', '추석 연휴'],
    ['2027-10-03', '개천절'],
    ['2027-10-04', '개천절 대체'],
    ['2027-10-09', '한글날'],
    ['2027-10-11', '한글날 대체'],
    ['2027-12-25', '성탄절'],
    ['2027-12-27', '성탄절 대체'],
  ];

  private static rows(): ReadonlyArray<readonly [string, string]> {
    return [...Holiday20271764000000000.Y2026_ADDED, ...Holiday20271764000000000.Y2027];
  }

  public async up(q: QueryRunner): Promise<void> {
    for (const [onDate, name] of Holiday20271764000000000.rows()) {
      await q.query(`INSERT INTO holiday (on_date, name) VALUES ($1::date, $2) ON CONFLICT DO NOTHING`, [onDate, name]);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [onDate, name] of Holiday20271764000000000.rows()) {
      await q.query(`DELETE FROM holiday WHERE on_date = $1::date AND name = $2`, [onDate, name]);
    }
  }
}
