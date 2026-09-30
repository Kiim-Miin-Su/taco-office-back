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
    const previousValue = before?.[kind] ?? null;
    // 구형 writer는 scalar만 바꿨을 수 있다. 신형 수정이 그 값을 덮기 전에 관찰된 이전 값을 이력으로 남긴다.
    // 실제 변경 시각/작성자는 알 수 없으므로 발견 시각의 legacy_copy로만 기록한다.
    if (previousValue !== null && previousValue !== value && selected?.value !== previousValue) {
      await q.query(
        `INSERT INTO guardian_contact(guardian_id,kind,value,active,is_delivery_selected,origin)
         VALUES ($1,$2,$3,false,false,'legacy_copy')`,
        [guardianId, kind, previousValue],
      );
    }
    if (selected?.value === value) continue;
    if (selected) {
      await q.query(`UPDATE guardian_contact SET is_delivery_selected = false, active = false WHERE id = $1`, [selected.id]);
    }
    if (value === null) continue;
    // 옛 writer가 남겨 아직 child가 없는 주소는 작성자를 추정하지 않는다.
    const isNewInput = before === null || previousValue !== value;
    await q.query(
      `INSERT INTO guardian_contact(guardian_id,kind,value,is_delivery_selected,origin,created_by)
       VALUES ($1,$2,$3,true,$4,$5)`,
      [guardianId, kind, value, isNewInput ? 'user' : 'legacy_copy', isNewInput ? actorId : null],
    );
  }
}
