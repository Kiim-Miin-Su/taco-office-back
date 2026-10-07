/** @file-guide
 * 목적: BO-09E-01 Kinder 일반 class 최종 명단 1대1을 지연 제약 trigger로 직접 SQL까지 방어한다.
 * 책임/재사용: 반복규칙·참여기간·취소·이동·회차 제외·실제 KST 시작의 marker version을 projection horizon 없이 검사한다.
 * 검증/작업 지침: docs/sprint/TBO-55/features/BOC-09E1-KINDER-ROSTER-GUARD-2026-10-08.md · docs/contracts/db/erd.dbml
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 권고안 채택(2026-10-08): 서비스 공통 검사 뒤에도 정본 표의 commit 최종상태를 DEFERRABLE trigger가 다시 본다.
 * 고정 90일 투영을 쓰지 않고 마지막 roster/exception/marker 변화 뒤 첫 반복 회차까지 생성한다.
 */
export class KinderRosterConstraint1767200000000 implements MigrationInterface {
  name = 'KinderRosterConstraint1767200000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE FUNCTION kinder_roster_conflict_for_ser(target_ser_id bigint)
      RETURNS jsonb LANGUAGE sql STABLE AS $$
      WITH settings AS (
        SELECT s.*,
          CASE WHEN upper(s.rrule) LIKE 'DAILY/%' OR upper(s.rrule) LIKE 'WEEKLY:%/%'
            THEN greatest(1,split_part(upper(s.rrule),'/',2)::integer) ELSE 1 END AS rule_interval,
          greatest(
            s.from_date,
            COALESCE((SELECT max(COALESCE(ss.to_date + 1,ss.from_date,s.from_date)) FROM ser_stu ss WHERE ss.ser_id=s.id),s.from_date),
            COALESCE((SELECT max(e.on_date) FROM exc e WHERE e.ser_id=s.id),s.from_date),
            COALESCE((SELECT max((m.effective_from AT TIME ZONE 'Asia/Seoul')::date + 1)
              FROM stu_kinder_marker m JOIN ser_stu ss ON ss.student_id=m.student_id WHERE ss.ser_id=s.id),s.from_date)
          ) AS stable_boundary
        FROM ser s WHERE s.id=target_ser_id AND s.kind_key='class'
      ), bounds AS (
        SELECT s.*,
          COALESCE(s.to_date,
            s.stable_boundary + CASE WHEN upper(s.rrule) LIKE 'WEEKLY:%' THEN s.rule_interval*7+6 ELSE s.rule_interval END
          ) AS check_to
        FROM settings s
      ), rule_dates AS (
        SELECT s.*,g.on_date::date
        FROM bounds s
        CROSS JOIN LATERAL generate_series(s.from_date,s.check_to,interval '1 day') g(on_date)
        WHERE CASE
          WHEN upper(s.rrule)='ONCE' THEN g.on_date::date=s.from_date
          WHEN upper(s.rrule) LIKE 'DAILY%' THEN mod(g.on_date::date-s.from_date,s.rule_interval)=0
          WHEN upper(s.rrule) LIKE 'WEEKLY:%' THEN
            position((ARRAY['SU','MO','TU','WE','TH','FR','SA'])[extract(dow FROM g.on_date)::integer+1]
              IN split_part(split_part(upper(s.rrule),':',2),'/',1))>0
            AND mod(((date_trunc('week',g.on_date)::date-date_trunc('week',s.from_date)::date)/7),s.rule_interval)=0
          ELSE false END
      ), actual AS (
        SELECT d.id AS ser_id,d.on_date,COALESCE(e.new_date,d.on_date) AS actual_date,
          COALESCE(e.start_min,d.start_min) AS actual_start_min,e.id AS exc_id
        FROM rule_dates d LEFT JOIN exc e ON e.ser_id=d.id AND e.on_date=d.on_date
        WHERE COALESCE(e.canceled,false)=false
      ), roster AS (
        SELECT a.ser_id,a.on_date,a.actual_date,a.actual_start_min,ss.student_id,
          ss.from_date AS roster_from,ss.to_date AS roster_to,
          COALESCE((SELECT m.marked FROM stu_kinder_marker m
            WHERE m.student_id=ss.student_id AND m.effective_from <=
              ((a.actual_date + make_interval(mins=>a.actual_start_min))::timestamp AT TIME ZONE 'Asia/Seoul')
            ORDER BY m.effective_from DESC,m.version DESC LIMIT 1),false) AS marked
        FROM actual a JOIN ser_stu ss ON ss.ser_id=a.ser_id
          AND (ss.from_date IS NULL OR ss.from_date<=a.on_date)
          AND (ss.to_date IS NULL OR ss.to_date>=a.on_date)
        WHERE NOT EXISTS (SELECT 1 FROM exc_stu_out xo WHERE xo.exc_id=a.exc_id AND xo.student_id=ss.student_id)
      ), conflicts AS (
        SELECT r.ser_id,r.on_date,r.actual_date,
          greatest(max(COALESCE(r.roster_from,s.from_date)),s.from_date) AS conflict_from,
          CASE WHEN count(*) FILTER (WHERE r.roster_to IS NULL)=count(*) AND s.to_date IS NULL THEN NULL
               ELSE min(COALESCE(r.roster_to,s.to_date,'infinity'::date)) END AS conflict_to,
          array_agg(r.student_id ORDER BY r.student_id) AS student_ids
        FROM roster r JOIN settings s ON s.id=r.ser_id
        GROUP BY r.ser_id,r.on_date,r.actual_date,s.from_date,s.to_date
        HAVING count(*)<>1 AND bool_or(r.marked)
        ORDER BY r.actual_date,r.on_date LIMIT 1
      )
      SELECT jsonb_build_object(
        'code','KINDER_GROUP_CONFLICT','serId',ser_id,'onDate',to_char(on_date,'YYYY-MM-DD'),
        'date',to_char(actual_date,'YYYY-MM-DD'),'conflictFrom',to_char(conflict_from,'YYYY-MM-DD'),
        'conflictTo',CASE WHEN conflict_to IS NULL THEN NULL ELSE to_char(conflict_to,'YYYY-MM-DD') END,
        'studentIds',student_ids
      ) FROM conflicts
      $$`);

    await q.query(`CREATE FUNCTION kinder_roster_constraint_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ser_ids bigint[]; conflict jsonb;
      BEGIN
        -- 서비스와 같은 전역 순서. 직접 SQL 두 transaction의 marker/명단 write-skew도 한 줄로 세운다.
        PERFORM pg_advisory_xact_lock_shared(hashtext('month_close:all-sensitive-writes'));
        PERFORM pg_advisory_xact_lock(hashtext('kinder_roster:all-marker-and-roster-writes'));
        IF TG_TABLE_NAME='stu_kinder_marker' THEN
          SELECT array_agg(DISTINCT ser_id) INTO ser_ids FROM ser_stu WHERE student_id=NEW.student_id;
        ELSIF TG_TABLE_NAME='ser' THEN
          ser_ids := ARRAY[NEW.id];
        ELSIF TG_TABLE_NAME='ser_stu' THEN
          IF TG_OP='INSERT' THEN ser_ids := ARRAY[NEW.ser_id];
          ELSIF TG_OP='DELETE' THEN ser_ids := ARRAY[OLD.ser_id];
          ELSE ser_ids := ARRAY[NEW.ser_id,OLD.ser_id]; END IF;
        ELSIF TG_TABLE_NAME='exc' THEN
          IF TG_OP='INSERT' THEN ser_ids := ARRAY[NEW.ser_id];
          ELSIF TG_OP='DELETE' THEN ser_ids := ARRAY[OLD.ser_id];
          ELSE ser_ids := ARRAY[NEW.ser_id,OLD.ser_id]; END IF;
        ELSIF TG_TABLE_NAME='exc_stu_out' THEN
          SELECT array_agg(DISTINCT e.ser_id) INTO ser_ids FROM exc e
            WHERE e.id=CASE WHEN TG_OP='DELETE' THEN OLD.exc_id ELSE NEW.exc_id END;
        END IF;
        SELECT kinder_roster_conflict_for_ser(id) INTO conflict
          FROM unnest(COALESCE(ser_ids,ARRAY[]::bigint[])) id
          WHERE id IS NOT NULL AND kinder_roster_conflict_for_ser(id) IS NOT NULL LIMIT 1;
        IF conflict IS NOT NULL THEN
          RAISE EXCEPTION 'Kinder class roster must contain exactly one student'
            USING ERRCODE='23514', CONSTRAINT='kinder_roster_one_to_one', DETAIL=conflict::text;
        END IF;
        RETURN COALESCE(NEW,OLD);
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER kinder_marker_roster_guard AFTER INSERT ON stu_kinder_marker
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kinder_roster_constraint_fn()`);
    await q.query(`CREATE CONSTRAINT TRIGGER kinder_ser_guard AFTER INSERT OR UPDATE ON ser
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kinder_roster_constraint_fn()`);
    await q.query(`CREATE CONSTRAINT TRIGGER kinder_ser_stu_guard AFTER INSERT OR UPDATE OR DELETE ON ser_stu
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kinder_roster_constraint_fn()`);
    await q.query(`CREATE CONSTRAINT TRIGGER kinder_exc_guard AFTER INSERT OR UPDATE OR DELETE ON exc
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kinder_roster_constraint_fn()`);
    await q.query(`CREATE CONSTRAINT TRIGGER kinder_exc_stu_out_guard AFTER INSERT OR UPDATE OR DELETE ON exc_stu_out
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kinder_roster_constraint_fn()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER kinder_exc_stu_out_guard ON exc_stu_out`);
    await q.query(`DROP TRIGGER kinder_exc_guard ON exc`);
    await q.query(`DROP TRIGGER kinder_ser_stu_guard ON ser_stu`);
    await q.query(`DROP TRIGGER kinder_ser_guard ON ser`);
    await q.query(`DROP TRIGGER kinder_marker_roster_guard ON stu_kinder_marker`);
    await q.query(`DROP FUNCTION kinder_roster_constraint_fn()`);
    await q.query(`DROP FUNCTION kinder_roster_conflict_for_ser(bigint)`);
  }
}
