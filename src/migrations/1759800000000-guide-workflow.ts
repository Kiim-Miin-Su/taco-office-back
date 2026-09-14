/** @file-guide
 * 목적: §43~§45 안내 이벤트의 안정 키·참조·중복 방어를 DB에 고정한다.
 * 책임/재사용: SER_OCC는 재생성되는 투영이므로 id를 GUIDE에 저장하지 않고 (ser,event,student,reason)을 영속 원장으로 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

export class GuideWorkflow1759800000000 implements MigrationInterface {
  name = 'GuideWorkflow1759800000000';

  async preflight(q: QueryRunner): Promise<Record<string, number>> {
    const [row] = await q.query(`SELECT
      (SELECT count(*)::int FROM guide g WHERE g.ser_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ser s WHERE s.id=g.ser_id)) AS guide_ser_fk,
      (SELECT count(*)::int FROM guide g WHERE NOT EXISTS (SELECT 1 FROM stu s WHERE s.id=g.student_id)) AS guide_student_fk,
      (SELECT count(*)::int FROM guide g WHERE g.teacher_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM staff s WHERE s.id=g.teacher_id)) AS guide_teacher_fk,
      (SELECT count(*)::int FROM guide WHERE reason NOT IN ('new','teacher_change')) AS guide_reason,
      (SELECT count(*)::int FROM pnoti p WHERE p.ser_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ser s WHERE s.id=p.ser_id)) AS pnoti_ser_fk,
      (SELECT count(*)::int FROM pnoti p WHERE NOT EXISTS (SELECT 1 FROM stu s WHERE s.id=p.student_id)) AS pnoti_student_fk,
      (SELECT count(*)::int FROM pnoti WHERE channel NOT IN ('sms','kakao','email','app')) AS pnoti_channel,
      (SELECT count(*)::int FROM (SELECT name FROM gtpl GROUP BY name HAVING count(*) > 1) d) AS gtpl_name_duplicate`);
    return row as Record<string, number>;
  }

  public async up(q: QueryRunner): Promise<void> {
    const counts = await this.preflight(q);
    if (Object.values(counts).some((count) => count !== 0)) {
      throw new Error(`Guide workflow preflight failed: ${JSON.stringify(counts)}`);
    }

    await q.query(`ALTER TABLE guide ADD COLUMN event_on date`);
    await q.query(`ALTER TABLE guide ADD COLUMN created_by bigint`);
    /* 레거시는 due_on이 실제 회차와 정확히 맞고 현재 명단/담당도 일치할 때만 안전하게 연결한다.
       나머지는 추측하지 않고 null로 남겨 이력 화면이 기존 due_on/created_at fallback을 쓰게 한다. */
    await q.query(`UPDATE guide g SET event_on=g.due_on
      WHERE g.ser_id IS NOT NULL AND g.due_on IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ser_occ o
          WHERE o.ser_id=g.ser_id AND o.on_date=g.due_on AND NOT o.canceled
            AND o.teacher_id IS NOT DISTINCT FROM g.teacher_id
        )
        AND EXISTS (SELECT 1 FROM ser_stu ss WHERE ss.ser_id=g.ser_id AND ss.student_id=g.student_id)`);

    await q.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM guide WHERE event_on IS NOT NULL
        GROUP BY ser_id,event_on,student_id,reason HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'duplicate GUIDE logical events require explicit merge';
      END IF;
    END $$`);

    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_ser_id_fk FOREIGN KEY (ser_id) REFERENCES ser(id)`);
    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_student_id_fk FOREIGN KEY (student_id) REFERENCES stu(id)`);
    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_teacher_id_fk FOREIGN KEY (teacher_id) REFERENCES staff(id)`);
    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_created_by_fk FOREIGN KEY (created_by) REFERENCES staff(id)`);
    await q.query(`ALTER TABLE guide ADD CONSTRAINT guide_reason_valid CHECK (reason IN ('new','teacher_change'))`);
    await q.query(`CREATE UNIQUE INDEX guide_event_unique
      ON guide (ser_id,event_on,student_id,reason) WHERE ser_id IS NOT NULL AND event_on IS NOT NULL`);
    await q.query(`CREATE INDEX guide_student_created_idx ON guide (student_id,created_at DESC,id DESC)`);
    await q.query(`CREATE INDEX guide_state_due_idx ON guide (state,due_on)`);

    await q.query(`ALTER TABLE pnoti ADD CONSTRAINT pnoti_ser_id_fk FOREIGN KEY (ser_id) REFERENCES ser(id)`);
    await q.query(`ALTER TABLE pnoti ADD CONSTRAINT pnoti_student_id_fk FOREIGN KEY (student_id) REFERENCES stu(id)`);
    await q.query(`ALTER TABLE pnoti ADD CONSTRAINT pnoti_channel_valid CHECK (channel IN ('sms','kakao','email','app'))`);
    await q.query(`CREATE INDEX pnoti_ser_date_idx ON pnoti (ser_id,on_date)`);
    await q.query(`CREATE INDEX pnoti_student_date_idx ON pnoti (student_id,on_date)`);
    await q.query(`CREATE UNIQUE INDEX gtpl_name_unique ON gtpl (name)`);

    /* 직접 SQL도 현재 회차·담당·명단과 무관한 이벤트를 새로 만들 수 없게 한다.
       이후 회차 재투영은 GUIDE를 건드리지 않으므로 과거 스냅샷과 일정 편집을 서로 막지 않는다. */
    await q.query(`CREATE FUNCTION guide_event_guard() RETURNS trigger AS $$
      DECLARE occ record;
      BEGIN
        IF NEW.event_on IS NULL THEN RETURN NEW; END IF;
        IF NEW.ser_id IS NULL THEN
          RAISE EXCEPTION 'GUIDE.event_on requires ser_id'
            USING ERRCODE='23514', CONSTRAINT='guide_event_source_valid';
        END IF;
        SELECT o.teacher_id,e.id AS exc_id INTO occ
          FROM ser_occ o LEFT JOIN exc e ON e.ser_id=o.ser_id AND e.on_date=o.on_date
         WHERE o.ser_id=NEW.ser_id AND o.on_date=NEW.event_on AND NOT o.canceled;
        IF NOT FOUND OR occ.teacher_id IS DISTINCT FROM NEW.teacher_id THEN
          RAISE EXCEPTION 'GUIDE event must match current SER_OCC teacher'
            USING ERRCODE='23514', CONSTRAINT='guide_event_source_valid';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM ser_stu ss
           WHERE ss.ser_id=NEW.ser_id AND ss.student_id=NEW.student_id
             AND NOT EXISTS (
               SELECT 1 FROM exc_stu_out xo
                WHERE xo.exc_id=occ.exc_id AND xo.student_id=NEW.student_id
             )
        ) THEN
          RAISE EXCEPTION 'GUIDE student must belong to source occurrence'
            USING ERRCODE='23514', CONSTRAINT='guide_event_student_valid';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER guide_event_guard_trigger
      BEFORE INSERT OR UPDATE OF ser_id,event_on,student_id,teacher_id ON guide
      FOR EACH ROW EXECUTE FUNCTION guide_event_guard()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS guide_event_guard_trigger ON guide`);
    await q.query(`DROP FUNCTION IF EXISTS guide_event_guard()`);
    await q.query(`DROP INDEX IF EXISTS gtpl_name_unique`);
    await q.query(`DROP INDEX IF EXISTS pnoti_student_date_idx`);
    await q.query(`DROP INDEX IF EXISTS pnoti_ser_date_idx`);
    await q.query(`ALTER TABLE pnoti DROP CONSTRAINT IF EXISTS pnoti_channel_valid`);
    await q.query(`ALTER TABLE pnoti DROP CONSTRAINT IF EXISTS pnoti_student_id_fk`);
    await q.query(`ALTER TABLE pnoti DROP CONSTRAINT IF EXISTS pnoti_ser_id_fk`);
    await q.query(`DROP INDEX IF EXISTS guide_state_due_idx`);
    await q.query(`DROP INDEX IF EXISTS guide_student_created_idx`);
    await q.query(`DROP INDEX IF EXISTS guide_event_unique`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_reason_valid`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_teacher_id_fk`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_created_by_fk`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_student_id_fk`);
    await q.query(`ALTER TABLE guide DROP CONSTRAINT IF EXISTS guide_ser_id_fk`);
    await q.query(`ALTER TABLE guide DROP COLUMN created_by`);
    await q.query(`ALTER TABLE guide DROP COLUMN event_on`);
  }
}
