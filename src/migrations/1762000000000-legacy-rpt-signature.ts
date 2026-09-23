/** @file-guide
 * 목적: 기존 대표 보고의 미상 서명을 보존하면서 현재 승인·반려를 기록할 수 있게 한다.
 * 책임/재사용: 신규/변경 서명 쌍의 완전성과 기존 STAFF FK를 지킨다. 과거 배우·시각은 추정하지 않는다.
 * 검증/작업 지침: docs/AGENT.md · docs/contracts/FILE-GUIDE.md · TBO-52 운영 전환
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class LegacyRptSignature1762000000000 implements MigrationInterface {
  name = 'LegacyRptSignature1762000000000';

  public async up(q: QueryRunner): Promise<void> {
    // NOT VALID CHECK도 기존 행의 모든 UPDATE를 검사해, 옛 발송자가 미상인 보고의 현재 결재를 막았다.
    // 변하지 않은 과거 서명만 보존한다. 새 행과 실제 변경한 쌍은 시각/배우를 함께 기록해야 한다.
    await q.query(`CREATE FUNCTION rpt_signature_transition_guard() RETURNS trigger AS $$
      DECLARE
        sent_changed boolean := true;
        reviewed_changed boolean := true;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          sent_changed := ROW(NEW.sent_at, NEW.sent_by) IS DISTINCT FROM ROW(OLD.sent_at, OLD.sent_by);
          reviewed_changed := ROW(NEW.reviewed_at, NEW.reviewed_by) IS DISTINCT FROM ROW(OLD.reviewed_at, OLD.reviewed_by);
        END IF;
        IF (sent_changed AND ((NEW.sent_at IS NULL) <> (NEW.sent_by IS NULL)))
          OR (reviewed_changed AND ((NEW.reviewed_at IS NULL) <> (NEW.reviewed_by IS NULL))) THEN
          RAISE EXCEPTION 'rpt_sign_pair: changed signature requires timestamp and actor together'
            USING ERRCODE = '23514', CONSTRAINT = 'rpt_sign_pair';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER rpt_signature_transition_trigger
      BEFORE INSERT OR UPDATE ON rpt
      FOR EACH ROW EXECUTE FUNCTION rpt_signature_transition_guard()`);
    await q.query('ALTER TABLE rpt DROP CONSTRAINT rpt_sign_pair');
  }

  public async down(q: QueryRunner): Promise<void> {
    // 원본을 바꾸지 않고 이전 방어선으로 돌아간다. legacy 보고의 UPDATE 제한도 다시 생긴다.
    await q.query(`ALTER TABLE rpt ADD CONSTRAINT rpt_sign_pair CHECK (
      (sent_at IS NULL) = (sent_by IS NULL)
      AND (reviewed_at IS NULL) = (reviewed_by IS NULL)
    ) NOT VALID`);
    await q.query('DROP TRIGGER rpt_signature_transition_trigger ON rpt');
    await q.query('DROP FUNCTION rpt_signature_transition_guard()');
  }
}
