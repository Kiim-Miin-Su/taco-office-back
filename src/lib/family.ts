/** @file-guide
 * 목적: family.ts — familyLinks (service)
 * 책임/재사용: 「학부모 연락처로 묶인 형제」를 한 벌 SQL로 찾는다. 보호자 목록(A-13)과 회계 형제 묶음이 같은 판정을 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

type Run = (sql: string, params: unknown[]) => Promise<unknown[]>;

export interface FamilyLink {
  studentId: number;
  studentName: string;
  grade: string | null;
  /** 이 학생 쪽에서 그 연락처를 가진 보호자 이름 — 「누구로 묶였나」 */
  via: string;
}

/**
 * A-13 「형제 둘이 같이 등록 — 학부모 연락처로 묶여 보인다」 (사용자 결정 2026-09-30 「묶음 표시 + 합산 보기」).
 *
 * **저장하지 않는다** — 가족 표를 새로 두지 않고 읽을 때마다 보호자(GUARDIAN) 연락처로 잇는다. 사용 중인 보호자끼리
 * 휴대폰(숫자만 · 저장 모양 그대로)이 같거나 이메일이 대소문자 무관하게 같으면 형제다. **한 단계만** 본다 — 이어진 이어진 사람까지
 * 번지지 않는다(연락처 하나를 바꾸면 묶음이 바로 바뀐다). 사용 중지한 보호자는 잇지 않는다.
 */
export async function familyLinks(run: Run, studentIds: number[]): Promise<Map<number, FamilyLink[]>> {
  const out = new Map<number, FamilyLink[]>();
  const ids = [...new Set(studentIds)];
  if (!ids.length) return out;
  const rows = (await run(
    `SELECT g1.student_id AS me, g2.student_id AS sib, st.name, st.grade,
            string_agg(DISTINCT g1.name, ' · ') AS via
       FROM guardian g1
       JOIN guardian g2 ON g2.active AND g2.student_id <> g1.student_id
        AND ((g1.phone IS NOT NULL AND g2.phone = g1.phone)
          OR (g1.email IS NOT NULL AND g2.email IS NOT NULL AND lower(g2.email) = lower(g1.email)))
       JOIN stu st ON st.id = g2.student_id
      WHERE g1.active AND g1.student_id = ANY($1::bigint[])
      GROUP BY g1.student_id, g2.student_id, st.name, st.grade
      ORDER BY g1.student_id, st.name, g2.student_id`,
    [ids],
  )) as Array<{ me: string; sib: string; name: string; grade: string | null; via: string }>;
  for (const r of rows) {
    const me = Number(r.me);
    if (!out.has(me)) out.set(me, []);
    out.get(me)!.push({ studentId: Number(r.sib), studentName: r.name, grade: r.grade ?? null, via: r.via });
  }
  return out;
}
