/** @file-guide
 * 목적: ST1-b3a 구형 guardian.email/phone writer와 선택 수신처 행을 같은 transaction에 기록한다.
 * 책임/재사용: 기존 보호자 생성·수정과 LEAD 승계가 이 한 함수를 쓴다. 신규 다중 연락처 API나 동의 정책은 구현하지 않는다.
 * 검증/작업 지침: docs/spec/STUDENT-REGISTRATION-2026-09-30.md · docs/contracts/db/student-registration-target.dbml
 */

import type { QueryRunner } from 'typeorm';

export interface LegacyGuardianContacts { email: string | null; phone: string | null }

/** 호출자는 STU → GUARDIAN 순서로 잠근 상태여야 한다. 이전 행은 지우지 않고 선택 해제·비활성으로 보존한다. */
export async function syncLegacyGuardianContacts(
  q: QueryRunner, guardianId: number, before: LegacyGuardianContacts | null,
  after: LegacyGuardianContacts, actorId: number,
): Promise<void> {
  for (const kind of ['email', 'phone'] as const) {
    const value = after[kind];
    const [selected] = await q.query(
      `SELECT id, value FROM guardian_contact
        WHERE guardian_id = $1 AND kind = $2 AND is_delivery_selected FOR UPDATE`,
      [guardianId, kind],
    ) as Array<{ id: string; value: string }>;
    if (selected?.value === value) continue;
    if (selected) {
      await q.query(`UPDATE guardian_contact SET is_delivery_selected = false, active = false WHERE id = $1`, [selected.id]);
    }
    if (value === null) continue;
    // 옛 writer가 남겨 아직 child가 없는 주소는 작성자를 추정하지 않는다.
    const isNewInput = before === null || before[kind] !== value;
    await q.query(
      `INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin,created_by)
       VALUES ($1,$2,$3,true,$4,$5)`,
      [guardianId, kind, value, isNewInput ? 'user' : 'legacy_copy', isNewInput ? actorId : null],
    );
  }
}
