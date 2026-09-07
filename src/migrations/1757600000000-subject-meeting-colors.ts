import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TBO-48C-1b · 원본 v2 §89. 잘못 배포된 기본색만 교정한다.
 * key와 이전 색이 모두 맞아야 하므로 사용자 지정 색·다른 과목은 보존한다.
 * seed는 나중에 바뀔 수 있으므로 당시 교정값은 이 migration에 고정한다.
 */
export class SubjectMeetingColors1757600000000 implements MigrationInterface {
  name = 'SubjectMeetingColors1757600000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE sub AS s
      SET color = correction.new_color
      FROM (VALUES
        ('mt-mk', '#5C7A9E', '#9A5B71'),
        ('mt-dv', '#4F7F6B', '#546FA2'),
        ('mt-pg', '#7A7A8C', '#856C4A')
      ) AS correction(key, old_color, new_color)
      WHERE s.key = correction.key AND s.color = correction.old_color`);
  }

  async down(): Promise<void> {
    // 새 색만 보고 역 UPDATE하면 원래부터 정색이었던 행까지 오색으로 덮는다.
    // 무동작 down도 적용 이력을 지우므로 거절한다. 복원은 적용 전 증거를 검토한 후속 migration으로 한다.
    throw new Error('Subject meeting colors correction is forward-only; review pre-migration evidence before a follow-up correction');
  }
}
