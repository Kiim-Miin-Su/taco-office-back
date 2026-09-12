/** @file-guide
 * 목적: 1759000000000-kind-sub-source-words.ts — KindSubSourceWords1759000000000 (migration)
 * 책임/재사용: 스키마 전이만 담고 업무 규칙을 복제하지 않는다. 되돌릴 수 없는 전이는 down에서 분명히 거절한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KIND · SUB 의 **이름과 분류를 원문 표로 되돌린다** (명세서 v2 슬라이드 88·89 · C54).
 *
 * 이름이 조금씩 달라져 있었다 — 종류 여섯 개(「정규 수업」·「모의고사」·「GPA 관리」·
 * 「자습 관리」·「진단 평가」)와 과목 열세 개(「Vocab」·「자습실」·「모의 SAT」·「회의 · 기획」 …).
 * 화면에 그대로 나오는 말이라 원문과 대조할 때마다 번역부터 하고 있었다 (D-R18).
 *
 * **분류 하나가 실제로 틀려 있었다.** `consulting` 이 `lesson` 에 있었다. 원문 §18 서랍의
 * 머리글은 **「수업 4 · 상담·진단 3 · 회의 1」** 인데, `consulting` 이 `lesson` 이면 5·2·1 이 된다.
 * 원문 표(슬라이드 88)도 `consulting` 을 `intake` 로 적는다. 두 곳이 같은 말을 하고 있었는데
 * 우리만 달랐다.
 *
 * **키로 찾아 고친다.** 키는 한 번 정하면 바꾸지 않는 값이라 어느 행인지 정확히 가리킨다 —
 * 추정 이관이 아니다. 이름을 손으로 바꿔 둔 행이 있어도 키가 같으면 원문 이름으로 돌아간다.
 *
 * **정원 둘은 건드리지 않는다.** 원문은 `mock` · `gpa` 를 정원 1 로 적지만, 시드의
 * 「모의 SAT 정기」가 4인이고 GPA 회차가 2인이다. 내리면 있는 행이 정원을 넘는다 —
 * 데이터를 함께 옮기는 일이라 결정 요청으로 올렸다 (N-30).
 */
export class KindSubSourceWords1759000000000 implements MigrationInterface {
  name = 'KindSubSourceWords1759000000000';

  /** [키, 이름, 정원, 분류] — 슬라이드 88 표의 행 순서 그대로 */
  private static readonly KINDS: Array<[string, string, number, string]> = [
    ['class', '수업', 4, 'lesson'],
    ['mock', '모의수업', 20, 'lesson'],
    ['gpa', 'GPA', 4, 'lesson'],
    ['study', '자습', 12, 'lesson'],
    ['consult', '상담', 3, 'intake'],
    ['diagx', '진단고사', 8, 'intake'],
    ['consulting', '컨설팅', 3, 'intake'],
    ['meeting', '회의', 10, 'meeting'],
  ];

  /** [키, 이름] — 슬라이드 89 표. 색은 이미 같아 손대지 않는다 */
  private static readonly SUBS: Array<[string, string]> = [
    ['vocab', 'Vocabulary'],
    ['ap-chem', 'AP Chem'],
    ['study-room', '학습실'],
    ['gpa-care', 'GPA 관리'],
    ['mock-sat', '모의수업 A'],
    ['mock-map', '모의수업 B'],
    ['intake', '입학 상담'],
    ['admissions', '진학 컨설팅'],
    ['mt-pl', '기획 회의'],
    ['mt-cs', '컨설팅 회의'],
    ['mt-mk', '마케팅 회의'],
    ['mt-dv', '개발 회의'],
    ['mt-pg', '일반 회의'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [key, name, cap, grp] of KindSubSourceWords1759000000000.KINDS) {
      await q.query(
        `UPDATE kind SET name = $2, cap = $3, grp = $4::kind_grp_t WHERE key = $1`,
        [key, name, cap, grp],
      );
    }
    for (const [key, name] of KindSubSourceWords1759000000000.SUBS) {
      await q.query(`UPDATE sub SET name = $2 WHERE key = $1`, [key, name]);
    }
  }

  /**
   * 되돌리지 않는다. 옛 이름은 **원문과 다른 쪽**이라 되살릴 값이 아니고,
   * 그 사이에 관리자가 §18 화면에서 이름을 고쳤을 수도 있다 — 그것까지 덮으면 남의 글을 지운다.
   */
  public async down(): Promise<void> {
    throw new Error('KindSubSourceWords1759000000000 은 되돌리지 않습니다 — 옛 이름은 원문과 다른 쪽입니다');
  }
}
