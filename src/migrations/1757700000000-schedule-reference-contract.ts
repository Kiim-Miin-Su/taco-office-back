import { MigrationInterface, QueryRunner } from 'typeorm';

/** §79/80 · D-R43: 당시 확정 DBML 참조만 고정한다. 런타임 도메인/생성기에 의존하지 않는다. */
const references = [
  ['ser', 'kind_key', 'kind', 'key'], ['ser', 'sub_key', 'sub', 'key'],
  ['ser', 'teacher_id', 'staff', 'id'], ['ser', 'room_id', 'room', 'id'],
  ['ser_stu', 'ser_id', 'ser', 'id'], ['ser_stu', 'student_id', 'stu', 'id'],
  ['exc', 'ser_id', 'ser', 'id'], ['exc', 'teacher_id', 'staff', 'id'],
  ['exc', 'room_id', 'room', 'id'], ['exc', 'by_id', 'staff', 'id'],
  ['exc_stu_out', 'exc_id', 'exc', 'id'], ['exc_stu_out', 'student_id', 'stu', 'id'],
] as const;

/** 제약만 추가/철회한다. 고아 자동 보정·삭제 금지. 운영 적용은 대상/preflight/lock 검토 후 수행한다. */
export class ScheduleReferenceContract1757700000000 implements MigrationInterface {
  name = 'ScheduleReferenceContract1757700000000';

  /** NULL 미지정은 합법이다. 건수만 반환해 학생·직원 개인정보를 로그에 남기지 않는다. */
  async preflight(q: QueryRunner): Promise<Record<string, number>> {
    // 식별자는 위 불변 allowlist만 사용한다. 모든 count는 한 snapshot에서 읽는다.
    const columns = references.map(([table, column, parent, key]) =>
      `(SELECT count(*)::int FROM ${table} c WHERE c.${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${key}=c.${column})) AS ${table}_${column}_fk`);
    const [counts] = await q.query(`SELECT ${columns.join(',')}`) as Record<string, number>[];
    return counts;
  }

  async up(q: QueryRunner): Promise<void> {
    const counts = await this.preflight(q);
    if (Object.values(counts).some((count) => count !== 0)) {
      throw new Error(`Schedule reference preflight failed: ${JSON.stringify(counts)}`);
    }
    // FK 생성은 기존 행까지 검증한다. preflight 뒤 유입된 고아도 통과시키지 않는다.
    // 삭제는 persist의 자식 우선 순서가 소유한다. CASCADE/SET NULL로 이력을 몰래 지우지 않는다.
    for (const [table, column, parent, key] of references) {
      await q.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_fk
        FOREIGN KEY (${column}) REFERENCES ${parent} (${key}) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    for (const [table, column] of [...references].reverse()) {
      await q.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_${column}_fk`);
    }
  }
}
