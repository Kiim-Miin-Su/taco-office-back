/** @file-guide
 * 목적: holiday 테이블 ORM 매핑 — Holiday (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * HOLIDAY — 공휴일 이름표 (erd.dbml v4.48 · 원문 §09 「광복절」·「광복절 대체」 칩, §10 요일 머리).
 *
 * 화면이 공휴일 표를 들고 있으면 「업무 데이터를 화면에 두지 않는다」는 상시 규칙을 어긴다 —
 * 그래서 서버 표다. 한 날에 이름이 둘일 수 있어(추석 연휴와 개천절이 겹치는 해) 키는 (날짜, 이름)이다.
 * 표시만 한다 — 일정을 막거나 회차를 지우지 않는다(원문 컷도 칩만 보여 준다).
 */
import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'holiday' })
export class Holiday {
  @PrimaryColumn({ type: 'date' })
  onDate: string;

  @PrimaryColumn({ type: 'varchar', length: 40 })
  name: string;
}
