/** @file-guide
 * 목적: 1763100000000-schedule-holiday.ts — ScheduleHoliday1763100000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 공휴일 이름표 HOLIDAY (erd.dbml v4.48 · 원문 §09 월간 칸 「광복절」·「광복절 대체」 칩 · §10 요일 머리 · g1 §09 #2 · §10 #8).
 *
 * 화면이 정적 공휴일 표를 들면 「업무 데이터를 화면에 두지 않는다」는 상시 규칙을 어기므로 서버 표로 둔다.
 * 한 날에 이름이 둘일 수 있어 키는 (on_date, name)이다.
 *
 * **2026년 법정 공휴일을 이 파일이 함께 넣는다** — 공휴일은 추정이 아니라 관보의 사실이고,
 * 이 표는 시드만으로 채우면 운영 DB 에서 비어 칩이 영영 서지 않는다. 대체공휴일 이름은 원문 컷의
 * 낱말(「광복절 대체」)을 따른다. 다른 해는 들어 있지 않다 — 누가 언제 더하는지는 로그의 「대표 결정 필요」에 적었다.
 * 시드 `--reset` 이 이 표를 비우지 않는다(SEEDED_TABLES 밖 — 참고 자료다).
 *
 * `down` 은 표를 통째로 지운다(이 표를 읽는 것은 표시뿐이고 다른 표가 참조하지 않는다).
 */
export class ScheduleHoliday1763100000000 implements MigrationInterface {
  name = 'ScheduleHoliday1763100000000';

  /** 2026 대한민국 공휴일 — 관공서의 공휴일에 관한 규정 · 대체공휴일(일요일·토요일 겹침) · 제9회 전국동시지방선거 */
  private static readonly Y2026: ReadonlyArray<readonly [string, string]> = [
    ['2026-01-01', '신정'],
    ['2026-02-16', '설날 연휴'],
    ['2026-02-17', '설날'],
    ['2026-02-18', '설날 연휴'],
    ['2026-03-01', '삼일절'],
    ['2026-03-02', '삼일절 대체'],
    ['2026-05-05', '어린이날'],
    ['2026-05-24', '부처님오신날'],
    ['2026-05-25', '부처님오신날 대체'],
    ['2026-06-03', '지방선거'],
    ['2026-06-06', '현충일'],
    ['2026-08-15', '광복절'],
    ['2026-08-17', '광복절 대체'],
    ['2026-09-24', '추석 연휴'],
    ['2026-09-25', '추석'],
    ['2026-09-26', '추석 연휴'],
    ['2026-10-03', '개천절'],
    ['2026-10-05', '개천절 대체'],
    ['2026-10-09', '한글날'],
    ['2026-12-25', '성탄절'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE holiday (
        on_date date        NOT NULL,
        name    varchar(40) NOT NULL,
        CONSTRAINT holiday_pk PRIMARY KEY (on_date, name),
        CONSTRAINT holiday_name_present CHECK (length(btrim(name)) > 0)
      )`);
    for (const [onDate, name] of ScheduleHoliday1763100000000.Y2026) {
      await q.query(`INSERT INTO holiday (on_date, name) VALUES ($1::date, $2) ON CONFLICT DO NOTHING`, [onDate, name]);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS holiday`);
  }
}
