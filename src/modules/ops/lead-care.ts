/** @file-guide
 * 목적: lead-care.ts — planLeadCare, continueLeadCare, firstActualLessonOn, LEAD_CARE_JSON (service helper) · W11 N-86 등록 뒤 사후 관리.
 * 책임/재사용: 사후 관리 할 일(todo.src='lead')을 **쓰는 곳은 여기 둘뿐**이다 — 등록 확정(planLeadCare)과 할 일 완료(continueLeadCare).
 *   부르는 쪽의 트랜잭션 러너를 그대로 받는다(밖에서 따로 커밋하지 않는다). 날짜 규칙은 lib/intake-words 한 곳.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * W11 · N-86 채택 — 「② 담당의 할 일 + DQ2 권장안」.
 *
 *   · 등록 확정 트랜잭션에서 **해피콜**(첫 실제 수업 + 7일 · A-14)과 **첫 월간 상담**(다음 달 같은 날, 없으면 그 달 말일)을
 *     상담 담당에게 할 일로 만든다. 담당이 없거나 그만뒀으면 받는 사람 없이 둔다(§64 「담당 없음」) — 아무도 안 보는 수신함에 넣지 않는다(S4).
 *   · 월간은 **끝나면 다음 달 하나**를 잇는다 — 휴원 중이면 복귀 뒤로, 수강 종료면 멈춘다. 완료 이력은 지우지 않는다.
 *   · 「첫 실제 수업」은 시작일 이전 회차를 잡지 않는다(S13 완료 기준) — 취소 · 그날 빠짐 · 휴원인 날도 아니다.
 *   · 등록 재시도에 중복이 서지 않는다 — 등록 확정은 상담 건을 잠그고 두 번 받지 않으며(ALREADY_ENROLLED), 표의 부분 유니크가 마지막으로 막는다.
 *
 * 알림은 보내지 않는다 — 할 일 자체가 담당의 서랍(§15)과 운영 할 일(§64)에 선다. 등록 확정 알림은 이미 관리자 전원에게 간다.
 */
import { addDays, todayKst } from '../../lib/kst';
import {
  LEAD_HAPPYCALL_DAYS, leadCareTitle, leadMonthlyNextOn, type LeadCarePause,
} from '../../lib/intake-words';
import { kstDateOf, stuPausedOn } from '../../lib/sql';

/** 쿼리 한 모양 — QueryRunner · EntityManager 어느 것이든 `query` 하나만 쓴다 */
export interface LeadCareQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

type Row = Record<string, unknown>;
const rows = async (q: LeadCareQueryable, sql: string, p: unknown[] = []): Promise<Row[]> => {
  const res = await q.query(sql, p);
  return (Array.isArray(res) ? res : []) as Row[];
};

/**
 * 등록 카드가 읽는 사후 관리 두 줄 — **같은 SELECT 의 JSON 한 칸**이다(`OpsService.leadRows` · 왕복 수 그대로).
 * 해피콜 한 줄과 **첫 월간 상담**(가장 먼저 만든 월간) 한 줄. 없으면 null(옛 등록 건).
 * @param lead 상담 별칭의 id 표현식 (예: `l.id`)
 */
export const leadCareJson = (lead: string): string => `json_build_object(
    'happy', (SELECT json_build_object('due', to_char(t.due_on,'YYYY-MM-DD'), 'done', t.done)
                FROM todo t WHERE t.lead_id = ${lead} AND t.care = 'happycall' ORDER BY t.id LIMIT 1),
    'firstMonthly', (SELECT json_build_object('due', to_char(t.due_on,'YYYY-MM-DD'), 'done', t.done)
                FROM todo t WHERE t.lead_id = ${lead} AND t.care = 'monthly' ORDER BY t.id LIMIT 1))`;

/**
 * 첫 **실제** 수업일 — 새로 만든 규칙들의 회차 중 시작일 이후 첫 날(A-14).
 * 날은 회차가 **실제로 놓인 날**(옮긴 회차는 옮긴 날)이고, 휴강 · 그날 빠짐 · 휴원인 날은 수업이 아니다.
 * 시작일 이전 회차는 잡지 않는다 — 규칙이 시작일보다 앞선 회차를 들고 있어도(S13 완료 기준).
 */
export async function firstActualLessonOn(
  q: LeadCareQueryable, serIds: readonly number[], studentId: number, startedOn: string,
): Promise<string | null> {
  if (!serIds.length) return null;
  const on = kstDateOf('lower(o.span)');
  const [r] = await rows(q,
    `SELECT to_char(min(${on}),'YYYY-MM-DD') AS first_on
       FROM ser_occ o
      WHERE o.ser_id = ANY($1::bigint[]) AND NOT o.canceled AND ${on} >= $2::date
        AND NOT EXISTS (SELECT 1 FROM exc e JOIN exc_stu_out xo ON xo.exc_id = e.id
                         WHERE e.ser_id = o.ser_id AND e.on_date = o.on_date AND xo.student_id = $3)
        AND NOT ${stuPausedOn('$3', on)}`,
    [[...serIds], startedOn, studentId]);
  return (r?.first_on as string | null) ?? null;
}

/** 그 학생의 휴원 기간 · 수강 끝 — 다음 월간 날을 정하는 재료(lib `leadMonthlyNextOn`) */
async function careContext(q: LeadCareQueryable, studentId: number): Promise<{ pauses: LeadCarePause[]; enrollEnd: string | null | undefined }> {
  const pauses = (await rows(q,
    `SELECT to_char(from_date,'YYYY-MM-DD') AS f, to_char(to_date,'YYYY-MM-DD') AS t
       FROM stu_pause WHERE student_id = $1 ORDER BY from_date`, [studentId]))
    .map((r) => ({ from: String(r.f), to: (r.t as string | null) ?? null }));
  const [e] = await rows(q,
    `SELECT count(*)::int AS n, bool_or(ended_on IS NULL) AS open, to_char(max(ended_on),'YYYY-MM-DD') AS last
       FROM enr WHERE student_id = $1`, [studentId]);
  const enrollEnd = Number(e?.n ?? 0) === 0 ? undefined : e?.open ? null : ((e?.last as string | null) ?? undefined);
  return { pauses, enrollEnd };
}

/** 받는 사람 — 상담 담당이 지금도 일하면 그 사람, 아니면 받는 사람 없이(§64 「담당 없음」) */
async function activeOwner(q: LeadCareQueryable, ownerId: number | null): Promise<{ id: number; name: string } | null> {
  if (ownerId == null) return null;
  const [s] = await rows(q, `SELECT id, name FROM staff WHERE id = $1 AND active`, [ownerId]);
  return s ? { id: Number(s.id), name: String(s.name) } : null;
}

async function insertCare(
  q: LeadCareQueryable,
  p: { leadId: number; care: 'happycall' | 'monthly'; title: string; fromId: number; toId: number | null; dueOn: string | null },
): Promise<number> {
  const [r] = await rows(q,
    `INSERT INTO todo (title, from_id, to_id, due_on, src, lead_id, care)
     VALUES ($1, $2, $3, $4::date, 'lead', $5, $6) RETURNING id`,
    [p.title, p.fromId, p.toId, p.dueOn, p.leadId, p.care]);
  return Number(r.id);
}

export interface LeadCarePlan {
  firstLessonOn: string | null;
  happyCallOn: string | null;
  monthlyOn: string | null;
  ownerId: number | null;
  ownerName: string | null;
  todoIds: number[];
}

/**
 * 등록 확정 — 해피콜 · 첫 월간 상담을 담당의 할 일로 만든다. **등록 확정과 같은 트랜잭션**의 `q` 로 부른다.
 * 첫 실제 수업을 모르면(투영 범위 밖) 두 할 일은 날짜 없이 선다 — 날을 짓지 않는다.
 */
export async function planLeadCare(
  q: LeadCareQueryable,
  p: { leadId: number; studentId: number; studentName: string; serIds: readonly number[]; startedOn: string; byId: number },
): Promise<LeadCarePlan> {
  const firstLessonOn = await firstActualLessonOn(q, p.serIds, p.studentId, p.startedOn);
  // 상담 담당 — 등록 확정이 이미 잠근 그 행에서 읽는다
  const [lead] = await rows(q, `SELECT owner_id FROM lead WHERE id = $1`, [p.leadId]);
  const owner = await activeOwner(q, lead?.owner_id == null ? null : Number(lead.owner_id));
  await q.query(`UPDATE lead SET first_lesson_on = $2::date WHERE id = $1`, [p.leadId, firstLessonOn]);
  const happyCallOn = firstLessonOn ? addDays(firstLessonOn, LEAD_HAPPYCALL_DAYS) : null;
  let monthlyOn: string | null = null;
  let monthly = true;
  if (firstLessonOn) {
    const ctx = await careContext(q, p.studentId);
    const next = leadMonthlyNextOn(firstLessonOn, firstLessonOn.slice(0, 7), ctx.pauses, ctx.enrollEnd);
    monthly = next !== null;
    monthlyOn = next?.on ?? null;
  }
  const todoIds = [await insertCare(q, {
    leadId: p.leadId, care: 'happycall', title: leadCareTitle('happycall', p.studentName), fromId: p.byId, toId: owner?.id ?? null, dueOn: happyCallOn,
  })];
  if (monthly) {
    todoIds.push(await insertCare(q, {
      leadId: p.leadId, care: 'monthly', title: leadCareTitle('monthly', p.studentName), fromId: p.byId, toId: owner?.id ?? null, dueOn: monthlyOn,
    }));
  }
  return { firstLessonOn, happyCallOn, monthlyOn: monthly ? monthlyOn : null, ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, todoIds };
}

/**
 * 할 일을 끝냈을 때 — 그것이 **월간 상담**이면 다음 달 하나를 잇는다. 할 일 완료와 **같은 트랜잭션**의 `q` 로 부른다.
 *
 * 다음 날은 **끝낸 월간의 달 + 1** 의 같은 날이다(날이 없는 월간이면 오늘의 달 + 1). 늦게 끝내도 그 달의 약속은 남는다 —
 * 늦게 끝낸 만큼 다음 것도 곧 온다(매월이라는 규칙이 그대로 선다).
 * 이미 뒤에 이어진 월간이 있으면 잇지 않는다 — 풀었다가 다시 끝내도, 옛 월간을 늦게 끝내도 두 개가 서지 않는다.
 * 상담 건을 잠그고 판정한다 — 두 사람이 동시에 끝내도 하나만 선다(표의 `todo_lead_monthly_on` 이 마지막으로 막는다).
 * @returns 새로 만든 할 일 id — 잇지 않았으면 null
 */
export async function continueLeadCare(q: LeadCareQueryable, todoId: number, byId: number): Promise<number | null> {
  const [t] = await rows(q,
    `SELECT id, lead_id, care, done, to_char(due_on,'YYYY-MM-DD') AS due_on FROM todo WHERE id = $1`, [todoId]);
  if (!t || t.care !== 'monthly' || t.done !== true || t.lead_id == null) return null;
  const [lead] = await rows(q,
    `SELECT l.id, l.stage, l.owner_id, l.student_id, to_char(l.first_lesson_on,'YYYY-MM-DD') AS first_lesson_on, s.name AS student_name
       FROM lead l LEFT JOIN stu s ON s.id = l.student_id
      WHERE l.id = $1 FOR UPDATE OF l`, [t.lead_id]);
  if (!lead || lead.stage !== 'enrolled' || lead.student_id == null) return null;
  const [later] = await rows(q,
    `SELECT 1 FROM todo WHERE lead_id = $1 AND care = 'monthly' AND id > $2 LIMIT 1`, [lead.id, t.id]);
  if (later) return null;
  const studentId = Number(lead.student_id);
  const anchor = (lead.first_lesson_on as string | null) ?? null;
  const afterMonth = ((t.due_on as string | null) ?? todayKst()).slice(0, 7);
  const ctx = await careContext(q, studentId);
  let dueOn: string | null = null;
  if (anchor) {
    const next = leadMonthlyNextOn(anchor, afterMonth, ctx.pauses, ctx.enrollEnd);
    if (next === null) return null; // 수강 종료 — 잇지 않는다
    dueOn = next.on;
  } else if (ctx.enrollEnd === undefined || (ctx.enrollEnd !== null && ctx.enrollEnd < todayKst())) {
    return null; // 기준일을 모르는 옛 건도 수강이 끝났으면 잇지 않는다
  }
  const owner = await activeOwner(q, lead.owner_id == null ? null : Number(lead.owner_id));
  return insertCare(q, {
    leadId: Number(lead.id), care: 'monthly', title: leadCareTitle('monthly', String(lead.student_name ?? '')),
    fromId: byId, toId: owner?.id ?? null, dueOn,
  });
}
