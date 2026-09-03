import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EXC의 nullable FK에서 "SER 값 상속"과 "이 회차는 미지정"을 분리한다 (D-R18).
 *
 * 기존 행은 값이 있을 때만 override였으므로 플래그를 안전하게 역산한다. 이후에는
 * `{ teacher_set: true, teacher_id: null }`이 명시적 강사 미지정을 뜻한다.
 */
export class ExcNullOverrides1757000000000 implements MigrationInterface {
  name = 'ExcNullOverrides1757000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE exc ADD COLUMN teacher_set boolean NOT NULL DEFAULT false');
    await q.query('ALTER TABLE exc ADD COLUMN room_set boolean NOT NULL DEFAULT false');
    await q.query(`UPDATE exc SET teacher_set = (teacher_id IS NOT NULL), room_set = (room_id IS NOT NULL)`);
    // 마이그레이션 직후 이전 서버가 잠시 쓰더라도 non-null FK는 override로 보존한다.
    await q.query(`
      CREATE FUNCTION exc_override_flags_compat() RETURNS trigger AS $$
      BEGIN
        IF NEW.teacher_id IS NOT NULL THEN NEW.teacher_set = true; END IF;
        IF NEW.room_id IS NOT NULL THEN NEW.room_set = true; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER exc_override_flags_compat_trigger
      BEFORE INSERT OR UPDATE OF teacher_id, room_id, teacher_set, room_set ON exc
      FOR EACH ROW EXECUTE FUNCTION exc_override_flags_compat()
    `);
    await q.query(`
      ALTER TABLE exc
        ADD CONSTRAINT exc_teacher_override_consistent CHECK (teacher_set OR teacher_id IS NULL),
        ADD CONSTRAINT exc_room_override_consistent CHECK (room_set OR room_id IS NULL)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TRIGGER exc_override_flags_compat_trigger ON exc');
    await q.query('DROP FUNCTION exc_override_flags_compat()');
    await q.query(`
      ALTER TABLE exc
        DROP CONSTRAINT exc_room_override_consistent,
        DROP CONSTRAINT exc_teacher_override_consistent,
        DROP COLUMN room_set,
        DROP COLUMN teacher_set
    `);
  }
}
