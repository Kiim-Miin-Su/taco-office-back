/** @file-guide
 * 목적: mkt 테이블 ORM 매핑 — Mkt (entity)
 * 책임/재사용: DB 레코드 매핑만 소유한다. DBML·migration·생성기/수동 보강 metadata를 함께 대조하고 여기에 UI/업무 정책을 넣지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * MKT — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Check, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// W11 · N-29 ① (migration 1764600000000) — 컷의 넷 + 옛 행의 코드. 낱말은 lib/marketing-words 한 곳
@Check('mkt_channel_words', "channel IN ('kakao','naver_ad','instagram','naver_blog','naver','daangn','youtube','referral','flyer')")
@Check('mkt_item_words', "item IN ('reply','ad','video','post','blog','biz','channel','word','print')")
@Entity({ name: 'mkt' })
export class Mkt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  /** 채널 — 원문 컷의 넷(카카오채널 · 네이버 광고 · 인스타그램 · 네이버 블로그) + 옛 행의 코드(이관 없음 · N-29 ①) */
  @Column({ type: 'varchar', length: 20 })
  channel: string;

  /** 항목 — 원문 컷의 넷(댓글·응대 · 광고 집행 · 릴스·영상 · 글 발행) + 옛 행의 코드. 채널과 **따로 움직인다** */
  @Column({ type: 'varchar', length: 20 })
  item: string;

  @Column({ type: 'text', nullable: true })
  url: string | null;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  /** 활동 이름 — 원문 §59·§60 카드의 제목 (C53) */
  @Column({ type: 'varchar', length: 120, nullable: true })
  title: string | null;

  /** 담당자 — 원문 §60 「담당자 답변」을 쓸 수 있는 사람 (C53) */
  @Column({ type: 'bigint', nullable: true })
  byId: number | null;

  /** 메모 한 줄 — 원문 §59 카드 제목 아래 「상담 예약 4건 전환」 · 「일 예산 5만 · CTR 3.1%」 (N-29 ② · MMEMO = MKT 의 한 칸) */
  @Column({ type: 'varchar', length: 120, nullable: true })
  memo: string | null;
}
