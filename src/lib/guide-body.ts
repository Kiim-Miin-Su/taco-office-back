/** @file-guide
 * 목적: guide-body.ts — GUIDE_FACT_KEYS, GuideFactKey, GuideFact, guideFacts, composeGuideBody 등 (util)
 * 책임/재사용: 현재 lib 계층의 순수 계산/표시 방어를 우선 재사용한다. UI·네트워크·DB 부수효과와 서버 업무 권위를 섞지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * §43 「안내 작성」의 **자동 채움** — F-60.
 *
 * 테스트 시나리오 F-60 이 세는 칸은 일곱이다: 학생 · 학년 · 강사 · 과목 · 형태 · 시작일 · 교재.
 * 이 일곱은 **이미 전부 저장돼 있었다** — `stu.grade` 는 §44 학생별이, `issue JOIN lib` 는 교재 칸이,
 * `ser.mode` 는 §43 회차 안내가, `sub.name` 은 시간표가 읽고 있다. **없던 것은 칸이 아니라
 * 한곳에 모으는 함수**였고, 그래서 안내를 쓰는 사람은 빈 칸에서 시작했다.
 *
 * **저장하지 않는다.** `guide.body` 는 사람이 쓴 말이고 이것은 지금의 사실이다. 초안에 굳혀 두면
 * 교재가 나중에 배정될 때 낡은 말이 남는다 — 그래서 아직 안 쓴 초안에만 읽을 때 실어 보내고,
 * 사람이 「작성」을 누르는 순간 기존 `PUT /guides/{id}/body` 가 그 텍스트를 굳힌다.
 * (문구 틀 GTPL 을 안내에 연결하지 않은 것과 같은 이유다 — 보낸 말이 나중에 달라지면 안 된다.)
 *
 * **낱말은 전부 여기 하나다** (D-R18). 화면이 「온라인」·「교재 아직 없습니다」를 짓지 않는다 —
 * 지으면 §43 작성 창과 §44 전문이 같은 사실을 다른 말로 적는다.
 */
import { issueActiveSql } from './book';
import { effectiveModeOf, kstDateOf, serStuOn } from './sql';

/**
 * 강사 교체 안내의 **이전 강사** — TEACHER-LINEAGE(2026-09-29).
 *
 * GUIDE 는 받는 강사(`teacher_id` = 교체 강사)만 적고 이전 강사 칸이 없다. 이전 강사는 새 칸이 아니라 **장부에서 되짚는다** —
 *   ① 마법사(`TeacherChangeService`)가 남긴 LOG `STAFF · teacher-change` 의 `before.teacherId`(그 LOG 의 `after.guideIds` 가 이 안내를 가리킨다).
 *      「이 날부터」는 규칙을 가르므로(D-R16) 새 규칙의 첫 회차 앞에는 같은 규칙의 회차가 없다 — 이 길만 답한다.
 *   ② 아니면 같은 규칙에서 그 학생이 든 **직전 회차**(실제로 한 차례 · `lower(span)` 순)의 강사 — §45 누락 판정(GUIDE_EVENT_CTE 의 `lag`)과 같은 뜻.
 *      그날만 대강(EXC)·§45 「안 한 것 클릭」으로 만든 초안이 이 길이다.
 * 첫 수업 안내(reason=new)는 null. 새 칸·마이그레이션 없이 읽기만 한다 — 안내마다 스칼라 둘이라 목록 하나에 왕복은 늘지 않는다.
 * `g` = guide 별칭 · `o` = 그 안내의 회차(LEFT JOIN · 없을 수 있다).
 */
export const PREVIOUS_TEACHER_SQL = (g = 'g', o = 'o'): string => `CASE WHEN ${g}.reason='teacher_change' THEN COALESCE(
      (SELECT (lg.before->>'teacherId')::bigint FROM log lg
        WHERE lg.entity='STAFF' AND lg.action='teacher-change' AND lg.after->'guideIds' @> to_jsonb(${g}.id)
        ORDER BY lg.id DESC LIMIT 1),
      (SELECT po.teacher_id FROM ser_occ po
         JOIN ser_stu pss ON pss.ser_id=po.ser_id AND pss.student_id=${g}.student_id AND ${serStuOn('pss', 'po.on_date')}
         LEFT JOIN exc px ON px.ser_id=po.ser_id AND px.on_date=po.on_date
        WHERE po.ser_id=${g}.ser_id AND NOT po.canceled
          AND (CASE WHEN ${o}.id IS NULL THEN po.on_date < ${g}.event_on ELSE lower(po.span) < lower(${o}.span) END)
          AND NOT EXISTS (SELECT 1 FROM exc_stu_out pxo WHERE pxo.exc_id=px.id AND pxo.student_id=${g}.student_id)
        ORDER BY lower(po.span) DESC, po.id DESC LIMIT 1)
    ) END`;

export const GUIDE_FACT_KEYS = ['student', 'grade', 'teacher', 'subject', 'mode', 'startOn', 'books'] as const;
/**
 * 강사 교체 안내(간이 안내 · F-62)에만 붙는 여덟째 칸 — **이전 강사**. 첫 수업 안내는 일곱 그대로다.
 * 값은 장부에서 되짚는다(`PREVIOUS_TEACHER_SQL` — 마법사 LOG 또는 같은 규칙의 직전 회차) · 새 칸 없음 (TEACHER-LINEAGE 2026-09-29).
 */
export const GUIDE_FACT_KEYS_TEACHER_CHANGE = [...GUIDE_FACT_KEYS, 'previousTeacher'] as const;
export type GuideFactKey = (typeof GUIDE_FACT_KEYS_TEACHER_CHANGE)[number];

/** 칸 이름 — 본문 머리말과 화면 칩이 같은 낱말을 쓴다 */
export const GUIDE_FACT_LABEL: Record<GuideFactKey, string> = {
  student: '학생',
  grade: '학년',
  teacher: '강사',
  subject: '과목',
  mode: '형태',
  startOn: '시작일',
  books: '교재',
  previousTeacher: '이전 강사',
};

/**
 * 못 채운 칸의 문장 — **「없음」이 아니라 왜 없는지**를 적는다.
 * 빈칸으로 두면 읽는 사람이 「빠뜨렸나」로 읽고, 「—」로 두면 무엇을 해야 하는지 알 수 없다.
 */
export const GUIDE_FACT_EMPTY: Record<GuideFactKey, string> = {
  student: '학생을 찾을 수 없습니다',
  grade: '학년이 적혀 있지 않습니다',
  teacher: '강사가 아직 정해지지 않았습니다',
  subject: '과목이 적혀 있지 않습니다',
  mode: '수업 형태를 알 수 없습니다',
  startOn: '시작일을 알 수 없습니다',
  books: '교재가 아직 배정되지 않았습니다',
  previousTeacher: '이전 강사를 알 수 없습니다',
};

/** 형태 낱말 — 시간표·§12 준비와 같은 말이다(현장은 강의실, 온라인은 줌) */
const MODE_LABEL: Record<string, string> = { offline: '현장', online: '온라인' };

/** 안내 종류 — `guide.reason` 두 가지(CHECK `guide_reason_valid`) */
const REASON_TITLE: Record<string, string> = {
  new: '첫 수업 안내',
  teacher_change: '강사 교체 안내',
};

export type GuideFact = { key: GuideFactKey; label: string; value: string | null; filled: boolean };
export type GuideAutoFill = { body: string; facts: GuideFact[] };

type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> };

/**
 * 일곱 칸을 한 질의로 읽는다 — 안내마다 따로 물으면 목록 하나에 왕복이 안내 수만큼 는다.
 *
 * 시작일은 **회차가 실제로 그려지는 날**이다(`ser_occ.span` 의 KST 날짜). 옮긴 회차도 옳게 적히고,
 * 투영이 없으면 저장된 `guide.event_on` 으로 떨어진다 — `guideRows` 가 쓰는 판정과 같다.
 * 교재는 **그 학생이 지금 갖고 있는 것**이다(`issueActiveSql` — §44 학생별과 같은 조건).
 */
export const GUIDE_FACT_SQL = `
  SELECT g.id, g.reason,
         st.name AS student_name, st.grade,
         t.name  AS teacher_name,
         -- 이전 강사(간이 안내만) — 장부에서 되짚는다 · 첫 수업 안내는 NULL (TEACHER-LINEAGE)
         (SELECT pt.name FROM staff pt WHERE pt.id = ${PREVIOUS_TEACHER_SQL('g', 'o')}) AS previous_teacher_name,
         sb.name AS subject_name,
         -- 형태 = 안내가 걸린 수업 날(event_on) 회차의 실제 방식 — 그 회차만 바꾼 예외(exc.mode)가 이긴다
         --   (N-56 「그 회차만」 · lib/sql 한 조각). 안내의 (ser_id, event_on) 이 곧 회차 키라 예외를 그 키로 붙인다 —
         --   투영이 없어도(호라이즌 밖) 그 회차의 예외를 읽고, 회차가 없으면(예외도 없다) 규칙의 방식이다(A′2)
         ${effectiveModeOf('x', 'r')} AS mode,
         COALESCE(to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD'), to_char(g.event_on,'YYYY-MM-DD')) AS start_on,
         (SELECT string_agg(DISTINCT l.title, ', ' ORDER BY l.title)
            FROM issue i JOIN lib l ON l.id = i.lib_id
           WHERE i.student_id = g.student_id AND ${issueActiveSql('i')}) AS books
    FROM guide g
    LEFT JOIN stu   st ON st.id = g.student_id
    LEFT JOIN staff t  ON t.id  = g.teacher_id
    LEFT JOIN ser   r  ON r.id  = g.ser_id
    LEFT JOIN sub   sb ON sb.key = r.sub_key
    LEFT JOIN ser_occ o ON o.ser_id = g.ser_id AND o.on_date = g.event_on
    LEFT JOIN exc x ON x.ser_id = g.ser_id AND x.on_date = g.event_on
   WHERE g.id = ANY($1::bigint[])`;

type FactRow = Record<string, unknown>;

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * 한 줄의 raw 행을 칸으로 — 순서는 `GUIDE_FACT_KEYS` 다(화면이 다시 정렬하지 않는다).
 * 강사 교체 안내는 여덟째 칸 「이전 강사」가 붙는다(`GUIDE_FACT_KEYS_TEACHER_CHANGE`) — 사유는 행이 말한다.
 */
export function factsOf(row: FactRow): GuideFact[] {
  const raw: Record<GuideFactKey, string | null> = {
    student: text(row.student_name),
    grade: text(row.grade),
    teacher: text(row.teacher_name),
    subject: text(row.subject_name),
    mode: MODE_LABEL[String(row.mode ?? '')] ?? null,
    startOn: text(row.start_on),
    books: text(row.books),
    previousTeacher: text(row.previous_teacher_name),
  };
  const keys = String(row.reason) === 'teacher_change' ? GUIDE_FACT_KEYS_TEACHER_CHANGE : GUIDE_FACT_KEYS;
  return keys.map((key) => ({
    key,
    label: GUIDE_FACT_LABEL[key],
    value: raw[key],
    filled: raw[key] !== null,
  }));
}

/**
 * 머리말 한 덩이 — **사실만 적는다.**
 *
 * 인사말·맺음말을 여기서 지어내지 않는다. 원문 §44 의 안내 전문이 어떤 문장으로 시작하는지는
 * 컷이 정하는 것이고, 지어 두면 사람이 매번 지우거나 — 더 나쁘게는 그대로 학부모에게 나간다.
 * 자동 채움은 **칸을 채우는 일**이지 글을 쓰는 일이 아니다.
 *
 * 머리말은 언제나 `\n\n` 으로 끝난다 — 「나머지 학생에게 복사」(F-61)가 이 앞자락을 떼고
 * 받는 학생의 머리말로 갈아 끼울 수 있는 것이 그 때문이다.
 */
export function composeGuideBody(facts: GuideFact[], reason: string): string {
  const title = REASON_TITLE[reason] ?? '수업 안내';
  const lines = facts.map((f) => `${f.label} ${f.value ?? `— ${GUIDE_FACT_EMPTY[f.key]}`}`);
  return [`[${title}]`, ...lines].join('\n') + '\n\n';
}

/** 안내 여럿의 자동 채움을 한 번에 — 초안이 아닌 줄은 부르는 쪽이 거른다 */
export async function guideAutoFills(m: Queryable, ids: number[]): Promise<Map<number, GuideAutoFill>> {
  const out = new Map<number, GuideAutoFill>();
  if (ids.length === 0) return out;
  const rows = (await m.query(GUIDE_FACT_SQL, [ids])) as FactRow[];
  for (const row of rows) {
    const facts = factsOf(row);
    out.set(Number(row.id), { body: composeGuideBody(facts, String(row.reason)), facts });
  }
  return out;
}

/** 한 건만 — 복사(F-61)가 원본과 받는 쪽 머리말을 각각 만들 때 쓴다 */
export async function guideAutoFill(m: Queryable, id: number): Promise<GuideAutoFill | null> {
  return (await guideAutoFills(m, [id])).get(id) ?? null;
}
