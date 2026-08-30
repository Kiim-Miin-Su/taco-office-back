/**
 * DB ↔ 리듀서 `State` 어댑터.
 *
 * **여기에 규칙은 없다.** 반복 3범위 판정은 전부 `lib/recurrence.ts` 가 갖고 (D-R16 · D-R21),
 * 이 파일은 그 순수 함수가 먹을 수 있게 표를 읽어 오고, 결과를 다시 표로 되돌릴 뿐이다.
 *
 *   load    DB → State (SER · SER_STU · EXC)
 *   reduce  순수 리듀서 (여기서 규칙이 적용된다)
 *   persist State 차이를 SQL 로
 *   project occ() 결과를 ser_occ 로 → EXCLUDE 가 최종 판정 (D-R43)
 *
 * 네 단계를 한 트랜잭션에 넣는 것은 서비스의 몫이다.
 */
import type { QueryRunner } from 'typeorm';
import type { Exc, IsoDate, Ser, SerStu, State } from '../../lib/recurrence';

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * 이 규칙들과 그 예외를 통째로 읽어 온다.
 *
 * 범위로 자르지 않는다 — 「향후」는 `to_date` 를 건드리고 「모두」는 규칙 자체를 바꾸므로,
 * 범위 밖의 예외까지 손에 들고 있어야 리듀서가 옳게 판단한다.
 */
export async function loadState(q: QueryRunner, serIds: number[]): Promise<State> {
  if (!serIds.length) return { SER: [], SER_STU: [], EXC: [] };

  const sers = (await q.query(
    `SELECT id, kind_key, sub_key, mode, title, teacher_id, room_id, start_min, end_min,
            rrule, from_date::text AS from_date, to_date::text AS to_date
       FROM ser WHERE id = ANY($1) ORDER BY id`,
    [serIds],
  )) as Row[];

  const stus = (await q.query(
    `SELECT ser_id, student_id FROM ser_stu WHERE ser_id = ANY($1)`,
    [serIds],
  )) as Row[];

  const excs = (await q.query(
    `SELECT e.id, e.ser_id, e.on_date::text AS on_date, e.canceled,
            e.new_date::text AS new_date, e.start_min, e.end_min,
            e.teacher_id, e.room_id, e.reason,
            COALESCE(
              (SELECT array_agg(o.student_id ORDER BY o.student_id)
                 FROM exc_stu_out o WHERE o.exc_id = e.id), '{}') AS stu_out
       FROM exc e WHERE e.ser_id = ANY($1) ORDER BY e.ser_id, e.on_date`,
    [serIds],
  )) as Row[];

  return {
    SER: sers.map<Ser>((r) => ({
      id: Number(r.id),
      kind: String(r.kind_key),
      sub: str(r.sub_key),
      mode: String(r.mode),
      title: String(r.title ?? ''),
      teacherId: num(r.teacher_id),
      roomId: num(r.room_id),
      startMin: Number(r.start_min),
      endMin: Number(r.end_min),
      rrule: String(r.rrule),
      fromDate: String(r.from_date),
      toDate: str(r.to_date),
    })),
    SER_STU: stus.map<SerStu>((r) => ({ serId: Number(r.ser_id), studentId: Number(r.student_id) })),
    EXC: excs.map<Exc>((r) => ({
      id: Number(r.id),
      serId: Number(r.ser_id),
      onDate: String(r.on_date),
      canceled: r.canceled === true,
      newDate: str(r.new_date),
      startMin: num(r.start_min),
      endMin: num(r.end_min),
      teacherId: num(r.teacher_id),
      roomId: num(r.room_id),
      reason: str(r.reason),
      stuOut: ((r.stu_out as number[]) ?? []).map(Number),
    })),
  };
}

/** SER 하나를 새로 넣고 **DB 가 준 id** 를 돌려준다. 리듀서가 만든 임시 id 는 버린다. */
async function insertSer(q: QueryRunner, s: Ser): Promise<number> {
  const r = (await q.query(
    `INSERT INTO ser (kind_key, sub_key, teacher_id, room_id, mode, start_min, end_min,
                      rrule, from_date, to_date, title)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11) RETURNING id`,
    [s.kind, s.sub, s.teacherId, s.roomId, s.mode, s.startMin, s.endMin,
     s.rrule, s.fromDate, s.toDate, s.title || null],
  )) as Array<{ id: string }>;
  return Number(r[0].id);
}

/**
 * `before` → `after` 의 차이를 SQL 로 옮긴다.
 *
 * 리듀서는 새 행에 **음수 임시 id** 를 붙인다(`mkGen`). 그것을 DB 시퀀스가 준 진짜 id 로
 * 바꿔 주는 것이 이 함수의 절반이다 — 임시 id 가 밖으로 새면 다음 요청에서 못 찾는다.
 *
 * @returns 바뀐 SER id 들. 호출한 쪽이 이 범위만 다시 투영하면 된다.
 */
export async function persist(q: QueryRunner, before: State, after: State): Promise<number[]> {
  const touched = new Set<number>();
  /** 리듀서의 임시 id → DB id */
  const idMap = new Map<number, number>();

  const beforeSer = new Map(before.SER.map((s) => [s.id, s]));
  const afterSer = new Map(after.SER.map((s) => [s.id, s]));

  // ── SER: 새로 생긴 것 · 바뀐 것 · 사라진 것
  for (const s of after.SER) {
    const old = beforeSer.get(s.id);
    if (!old) {
      const realId = await insertSer(q, s);
      idMap.set(s.id, realId);
      touched.add(realId);
      continue;
    }
    const changed =
      old.teacherId !== s.teacherId || old.roomId !== s.roomId ||
      old.startMin !== s.startMin || old.endMin !== s.endMin ||
      old.rrule !== s.rrule || old.fromDate !== s.fromDate || old.toDate !== s.toDate ||
      old.title !== s.title || old.mode !== s.mode || old.sub !== s.sub;
    if (changed) {
      await q.query(
        `UPDATE ser SET teacher_id=$2, room_id=$3, start_min=$4, end_min=$5,
                        rrule=$6, from_date=$7::date, to_date=$8::date, title=$9, mode=$10, sub_key=$11
          WHERE id=$1`,
        [s.id, s.teacherId, s.roomId, s.startMin, s.endMin, s.rrule, s.fromDate, s.toDate,
         s.title || null, s.mode, s.sub],
      );
      touched.add(s.id);
    }
  }
  for (const s of before.SER) {
    if (!afterSer.has(s.id)) {
      await q.query(`DELETE FROM ser_occ WHERE ser_id = $1`, [s.id]);
      await q.query(`DELETE FROM ser WHERE id = $1`, [s.id]);
      touched.delete(s.id);
    }
  }

  const real = (id: number): number => idMap.get(id) ?? id;

  // ── SER_STU: 키가 (serId, studentId) 뿐이라 집합 차이로 본다
  const keyOf = (r: SerStu) => `${real(r.serId)}|${r.studentId}`;
  const beforeStu = new Set(before.SER_STU.map((r) => `${r.serId}|${r.studentId}`));
  const afterStu = new Set(after.SER_STU.map(keyOf));
  for (const r of after.SER_STU) {
    if (beforeStu.has(`${r.serId}|${r.studentId}`)) continue;
    await q.query(
      `INSERT INTO ser_stu (ser_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [real(r.serId), r.studentId],
    );
    touched.add(real(r.serId));
  }
  for (const r of before.SER_STU) {
    if (afterStu.has(`${r.serId}|${r.studentId}`)) continue;
    await q.query(`DELETE FROM ser_stu WHERE ser_id=$1 AND student_id=$2`, [r.serId, r.studentId]);
    touched.add(r.serId);
  }

  // ── EXC: 키는 (serId, onDate). stuOut 은 자식 표라 따로 맞춘다
  const beforeExc = new Map(before.EXC.map((e) => [`${e.serId}|${e.onDate}`, e]));
  const afterKeys = new Set(after.EXC.map((e) => `${real(e.serId)}|${e.onDate}`));

  for (const e of after.EXC) {
    const sid = real(e.serId);
    const old = beforeExc.get(`${e.serId}|${e.onDate}`);
    const row = (await q.query(
      `INSERT INTO exc (ser_id, on_date, canceled, new_date, start_min, end_min, teacher_id, room_id, reason)
       VALUES ($1,$2::date,$3,$4::date,$5,$6,$7,$8,$9)
       ON CONFLICT (ser_id, on_date) DO UPDATE SET
         canceled=EXCLUDED.canceled, new_date=EXCLUDED.new_date,
         start_min=EXCLUDED.start_min, end_min=EXCLUDED.end_min,
         teacher_id=EXCLUDED.teacher_id, room_id=EXCLUDED.room_id, reason=EXCLUDED.reason
       RETURNING id`,
      [sid, e.onDate, e.canceled, e.newDate, e.startMin, e.endMin, e.teacherId, e.roomId, e.reason],
    )) as Array<{ id: string }>;
    const excId = Number(row[0].id);

    const oldOut = new Set(old?.stuOut ?? []);
    const newOut = new Set(e.stuOut ?? []);
    for (const sid2 of newOut) {
      if (oldOut.has(sid2)) continue;
      await q.query(
        `INSERT INTO exc_stu_out (exc_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [excId, sid2],
      );
    }
    for (const sid2 of oldOut) {
      if (newOut.has(sid2)) continue;
      await q.query(`DELETE FROM exc_stu_out WHERE exc_id=$1 AND student_id=$2`, [excId, sid2]);
    }
    touched.add(sid);
  }

  for (const e of before.EXC) {
    if (afterKeys.has(`${e.serId}|${e.onDate}`)) continue;
    await q.query(`DELETE FROM exc_stu_out WHERE exc_id=$1`, [e.id]);
    await q.query(`DELETE FROM exc WHERE ser_id=$1 AND on_date=$2::date`, [e.serId, e.onDate]);
    touched.add(e.serId);
  }

  return [...touched];
}

/** 리듀서가 만든 임시 id 를 DB id 로 바꾼 뒤의 SER 목록 — 응답에 쓴다. */
export type { IsoDate };
