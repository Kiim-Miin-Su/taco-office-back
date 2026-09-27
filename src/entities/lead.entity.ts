/** @file-guide
 * 목적: lead 테이블 ORM 매핑 — Lead (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * LEAD — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Check('lead_source_words', "source IS NULL OR source IN ('kakao','phone','blog','instagram','referral','walkin')")
@Check('lead_reason_kind_words', "reason_kind IS NULL OR reason_kind IN ('unreachable','other_academy','schedule','cost','timing')")
@Entity({ name: 'lead' })
export class Lead {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 등록되면 채워진다 */
  @Column({ type: 'bigint', nullable: true })
  studentId: number | null;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  school: string | null;

  @Column({ type: 'bigint', nullable: true })
  ownerId: number | null;

  /** 1차 · 2차대기 · 2차 · 보류 · 등록 · 실패 */
  @Column({ type: 'varchar', length: 16 })
  stage: string;

  /** 옛 중단 지점(before_book · before_first · after_first · after_second) — **읽기 전용 기록**.
   *  W11 · N-87 로 §24 분류는 실패 당시 단계(`failFrom`)에서 읽고 이 칸은 새로 쓰지 않는다(대응표 이관 없음 · N-25). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  stopAt: string | null;

  /** N-25 채택 — 실패 당시 이전 단계 **명시값**(전이 시 서버가 라이브로 기록).
   *  레거시 NULL 은 미분류로 보존 — stop_at 으로 추정 이관하지 않는다. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  failFrom: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** v4.45 · 실패 사유 분류 — unreachable | other_academy | schedule | cost | timing (원본 §24 다섯 · 24-05). 옛 실패 건은 NULL — 사유 글에서 추정하지 않는다 (N-25) */
  @Column({ type: 'varchar', length: 16, nullable: true })
  reasonKind: string | null;

  /** v4.45 · 학년 — 원본 §23 카드의 학년 칩 (23-10). `stu.grade` 와 같은 폭의 자유 글 · 옛 건 NULL */
  @Column({ type: 'varchar', length: 10, nullable: true })
  grade: string | null;

  /** v4.47 · 보류 재확인 날짜 (23-16) — 비면 보류에 들어온 날 + 2일. 「연장 +2일」이 적고 단계가 바뀌면 비운다 */
  @Column({ type: 'date', nullable: true })
  recheckOn: string | null;

  /** v4.34 · 유입 경로 — kakao | phone | blog | instagram | referral | walkin (컷 §23 · N-44). 옛 행은 NULL — 추정 보정 0 (N-25) */
  @Column({ type: 'varchar', length: 16, nullable: true })
  source: string | null;

  /**
   * W11 · N-86 · 등록 확정 때 잡은 **첫 실제 수업일** — 해피콜(+7일)과 월간 상담(매월 같은 날 · 없으면 말일)의 기준.
   * 회차는 투영이라 뒤에 바뀌면 날짜가 흔들린다 — 등록 순간의 사실로 굳혀 둔다. 옛 등록 건 · 등록 안 한 건은 NULL (보정 0 · N-25)
   */
  @Column({ type: 'date', nullable: true })
  firstLessonOn: string | null;

  @Column({ type: 'timestamptz', default: () => "now()" })
  createdAt: Date;
}
