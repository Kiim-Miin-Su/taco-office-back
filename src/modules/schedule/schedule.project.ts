/**
 * 투영 — `SER` + `EXC` (원본) → `ser_occ` (사본).
 *
 * `ser_occ` 는 **파생 표**다. 반복 규칙은 기간이 열려 있어 겹침 제약을 걸 대상이 없으므로,
 * 회차를 펼쳐 이 표에 넣고 **여기에** EXCLUDE 를 건다 (D-R43 · erd 부록 A).
 *
 * 그래서 규칙이 바뀔 때마다 다시 펼쳐야 한다. 안 하면 원본과 사본이 갈라지고,
 * 갈라진 사본이 겹침을 판정하게 된다 — 제약이 있으나 마나가 된다.
 *
 * 펼치는 함수는 `occ()` 하나다. **화면이 보는 목록과 제약이 걸리는 행이 같은 함수에서 나온다** (D-R1).
 */
import type { QueryRunner } from 'typeorm';
import { addD, occ, ruleHits, type IsoDate, type State } from '../../lib/recurrence';
import { todayKst } from '../../lib/kst';
import { REPORT_UNWRITTEN_CANDIDATE_DB } from '../../lib/rules';

/**
 * 펼쳐 두는 기간.
 *
 * 규칙은 끝이 없지만 표에는 끝이 있어야 한다. 뒤로는 지난 학기를 볼 만큼,
 * 앞으로는 다음 학기 시간표를 짤 만큼 둔다. 이 범위 밖은 **비어 있다는 사실을 화면이 말한다** —
 * 조용히 빈 달력이 제일 나쁘다.
 */
export const HORIZON_BACK = 90;
export const HORIZON_AHEAD = 180;

// 「오늘」은 lib/kst.ts 가 갖는다 — 자정 언저리에서 화면마다 답이 갈리지 않게
export { todayKst };

export function horizon(): { from: IsoDate; to: IsoDate } {
  const t = todayKst();
  return { from: addD(t, -HORIZON_BACK), to: addD(t, HORIZON_AHEAD) };
}

/** KST 의 분 단위 시각을 UTC 순간으로. `span` 이 tstzrange 라 여기서 한 번만 변환한다. */
function at(date: IsoDate, min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return new Date(
    `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`,
  ).toISOString();
}

/**
 * 리포트는 회차의 소비자다. 회차를 만든 뒤 같은 트랜잭션에서 REP·REP_STU까지 투영해야
 * 새 수업도 종료 시점에 독촉/작성 화면으로 자연스럽게 넘어간다.
 *
 * 제출 전 학생 목록은 현재 명단을 따라가고, 제출한 순간부터는 발송 대상 스냅샷으로 보존한다.
 */
async function projectReports(q: QueryRunner, serIds: number[]): Promise<void> {
  await q.query(
    `INSERT INTO rep (ser_id, on_date, teacher_id, kind_key, lang, body, state)
     SELECT o.ser_id, o.on_date, o.teacher_id, s.kind_key,
            COALESCE((
              SELECT st.lang
                FROM ser_stu ss JOIN stu st ON st.id = ss.student_id
               WHERE ss.ser_id = o.ser_id
               ORDER BY ss.student_id LIMIT 1
            ), 'ko'),
            '{}'::jsonb,
            CASE WHEN upper(o.span) <= now() THEN 'none'::rep_state_t ELSE 'plan'::rep_state_t END
       FROM ser_occ o
       JOIN ser s ON s.id = o.ser_id
       JOIN kind k ON k.key = s.kind_key
      WHERE o.ser_id = ANY($1) AND k.rep AND NOT o.canceled
     ON CONFLICT (ser_id, on_date) DO UPDATE SET
       teacher_id = EXCLUDED.teacher_id,
       kind_key = EXCLUDED.kind_key
     WHERE rep.state = ANY($2::rep_state_t[])`,
    [serIds, REPORT_UNWRITTEN_CANDIDATE_DB],
  );

  // 아직 제출하지 않은 리포트만 현재 명단으로 다시 만든다. wait/ok/rej는 제출 당시 대상을 보존한다.
  await q.query(
    `DELETE FROM rep_stu rs
      USING rep r
      WHERE rs.rep_id = r.id
        AND r.ser_id = ANY($1)
        AND r.state = ANY($2::rep_state_t[])`,
    [serIds, REPORT_UNWRITTEN_CANDIDATE_DB],
  );
  await q.query(
    `INSERT INTO rep_stu (rep_id, student_id, deliver)
     SELECT r.id, ss.student_id, true
       FROM rep r
       JOIN ser_occ o ON o.ser_id = r.ser_id AND o.on_date = r.on_date
       JOIN ser_stu ss ON ss.ser_id = r.ser_id
       LEFT JOIN exc e ON e.ser_id = o.ser_id AND e.on_date = o.on_date
      WHERE r.ser_id = ANY($1)
        AND r.state = ANY($2::rep_state_t[])
        AND NOT o.canceled
        AND NOT EXISTS (
          SELECT 1 FROM exc_stu_out xo
           WHERE xo.exc_id = e.id AND xo.student_id = ss.student_id
        )
     ON CONFLICT (rep_id, student_id) DO NOTHING`,
    [serIds, REPORT_UNWRITTEN_CANDIDATE_DB],
  );
}

/**
 * 주어진 규칙들의 회차를 기간만큼 다시 펼쳐 `ser_occ` 에 넣는다.
 *
 * 지우고 다시 넣는다. 「바뀐 것만 고치기」는 규칙·예외·명단이 함께 움직이는 이 도메인에서
 * 빠뜨리기 쉽고, 회차 수가 규칙당 수백 줄이라 통째로 다시 쓰는 편이 단순하고 빠르다.
 *
 * **트랜잭션 안에서 부른다.** 지운 뒤 넣기 전에 다른 트랜잭션이 겹침을 통과하면 안 된다.
 */
export async function project(
  q: QueryRunner,
  state: State,
  serIds: number[],
  range?: { from: IsoDate; to: IsoDate },
): Promise<number> {
  if (!serIds.length) return 0;
  const { from, to } = range ?? horizon();

  await q.query(
    `DELETE FROM ser_occ WHERE ser_id = ANY($1) AND on_date BETWEEN $2::date AND $3::date`,
    [serIds, from, to],
  );

  const want = new Set(serIds);
  const rows: Array<[number, string, number | null, number | null, boolean, string]> = [];

  /* `occ()` 는 **표시용**이라 휴강을 그리지 않는다 (「휴강 — 그리지 않는다」).
     투영은 그것만으로 부족하다 — 현황판이 「취소·휴강 n건」을 세려면 그 회차도 표에 있어야 하고,
     EXCLUDE 는 `WHERE canceled = false` 라 취소 행이 있어도 자리를 잡지 않는다.
     그래서 **그린 것 + 취소된 것**을 함께 넣는다. 판정은 여전히 한 함수에서 나온다. */
  const excAt = new Map(
    (state.EXC ?? []).map((e) => [`${e.serId}|${e.onDate}`, e]),
  );

  for (let d = from; d <= to; d = addD(d, 1)) {
    for (const o of occ(d, state)) {
      if (!want.has(o.serId)) continue;
      rows.push([
        o.serId,
        // EXC 의 키는 「원래 날짜」다. 옮긴 회차도 원래 날짜로 저장해야 예외를 다시 찾는다.
        o.onDate,
        o.teacherId,
        o.roomId,
        o.canceled,
        `[${at(o.date, o.startMin)},${at(o.date, o.endMin)})`,
      ]);
    }

    // 취소된 회차 — 규칙에는 맞는데 occ() 가 안 그린 것
    for (const ser of state.SER) {
      if (!want.has(ser.id)) continue;
      if (!ruleHits(ser, d)) continue;
      const e = excAt.get(`${ser.id}|${d}`);
      if (!e?.canceled) continue;
      rows.push([
        ser.id, d,
        e.teacherSet ? e.teacherId : ser.teacherId,
        e.roomSet ? e.roomId : ser.roomId,
        true,
        `[${at(d, e.startMin ?? ser.startMin)},${at(d, e.endMin ?? ser.endMin)})`,
      ]);
    }
  }
  if (!rows.length) return 0;

  // 한 번에 넣는다 — 회차마다 왕복하면 규칙 하나에 수백 번이 된다
  const vals: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 6;
    vals.push(...r);
    return `($${b + 1}, $${b + 2}::date, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::tstzrange)`;
  });

  await q.query(
    `INSERT INTO ser_occ (ser_id, on_date, teacher_id, room_id, canceled, span)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (ser_id, on_date) DO UPDATE SET
       teacher_id = EXCLUDED.teacher_id, room_id = EXCLUDED.room_id,
       canceled = EXCLUDED.canceled, span = EXCLUDED.span`,
    vals,
  );
  await projectReports(q, serIds);
  return rows.length;
}
