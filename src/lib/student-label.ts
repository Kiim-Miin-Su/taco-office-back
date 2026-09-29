/** @file-guide
 * 목적: student-label.ts — studentTagSql, studentLabel (lib)
 * 책임/재사용: 학생을 사람에게 보일 때 붙는 꼬리(학년 · 동명이인이면 학교 · 그래도 같으면 번호)의 판정 한 곳이다. 읽기 SQL 이 조각으로 끼워 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 동명이인 표기 (테스트 시나리오 N-137 「같은 이름의 학생이 둘 → 구분할 수 있게 표시된다(학년·학교)」).
 *
 * 일정 · 청구는 처음부터 학생 번호로 갈려 섞이지 않는다. 모자랐던 것은 **사람이 고르는 자리**다 —
 * 학생 고르기(스케줄 도구줄 · 일정 편집 · 컨설팅 · GPA …)가 이름만 적어 같은 이름 둘 중 누구인지 알 수 없었다.
 *
 * 꼬리(tag)는 이 차례로 붙는다 — 없는 칸은 건너뛴다.
 *   1. 학년 — 언제나(이미 여러 고르기가 「이름 · 학년」이었다 · 같은 모양으로 맞춘다)
 *   2. 학교 — 같은 이름의 다른 학생이 있을 때만(원문이 말한 「학년 · 학교」)
 *   3. `#번호` — 이름 · 학년 · 학교까지 같은 다른 학생이 있을 때만(그때는 사람이 가를 말이 남지 않는다)
 * 동명이인 판정은 **학생 전체**에서 한다 — 한 화면의 목록만 보면 그 화면에 없는 동명이인을 놓친다.
 * 화면은 이 꼬리를 다시 만들지 않는다(D-R18 · D-R37) — `label` · `tag` 를 그대로 그린다.
 */

/** SQL 표현식 — `stu` 별칭 `a` 의 꼬리(없으면 NULL). 학생 표는 작아(수백 행) EXISTS 두 번이 싸다. */
export const studentTagSql = (a: string): string => `NULLIF(concat_ws(' · ',
    NULLIF(btrim(${a}.grade), ''),
    CASE WHEN EXISTS (SELECT 1 FROM stu dup WHERE dup.name = ${a}.name AND dup.id <> ${a}.id)
         THEN NULLIF(btrim(${a}.school), '') END,
    CASE WHEN EXISTS (SELECT 1 FROM stu dup WHERE dup.name = ${a}.name AND dup.id <> ${a}.id
                        AND COALESCE(btrim(dup.grade), '') = COALESCE(btrim(${a}.grade), '')
                        AND COALESCE(btrim(dup.school), '') = COALESCE(btrim(${a}.school), ''))
         THEN '#' || ${a}.id END
  ), '')`;

/** 이름 + 꼬리 — 「김하윤 · G8 · 채드윅」. 꼬리가 없으면 이름 그대로 */
export const studentLabel = (name: string, tag: string | null | undefined): string => (tag ? `${name} · ${tag}` : name);
