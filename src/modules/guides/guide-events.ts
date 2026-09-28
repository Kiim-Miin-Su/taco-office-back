/** @file-guide
 * 목적: guide-events.ts — GUIDE_LESSON_JOINS, GUIDE_EVENT_CTE, guideCoversEvent, guideKindLabel (util)
 * 책임/재사용: 「누구에게 안내가 필요한가」(첫 수업 · 강사 교체) SQL 한 벌. §45 누락 카드·§43 할 일·§34 현황판 안내 마크가 같은 식을 쓴다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { kstAt, kstDateOf, START_MIN, serStuOn } from '../../lib/sql';

/**
 * 안내 한 줄의 **수업 이름표** — 과목 · 종류 · 강의실 (g4 「수업명 미정」 §43-3 · §44-1 · §45-1).
 *
 * 화면은 `SER.title` 만 받고 있었는데 정규 수업은 제목이 비어 있어(시드·등록 확정 모두) 모든 줄이
 * 「수업명 미정」이었고, 같은 학생의 두 수업이 구별되지 않았다. 과목(`sub.name`)과 종류(`kind.name`)·
 * 강의실을 함께 싣는다 — 강의실은 **회차가 있으면 그 회차의 것**(`ser_occ.room_id` · 투영이 이미 예외를 반영),
 * **회차가 없을 때만** 규칙의 것이다(안내 줄은 회차를 LEFT JOIN 한다 — 호라이즌 밖 · 투영 전).
 * 회차의 강의실이 비어 있으면(그 회차만 온라인) 비어 있는 것이 답이다 — 전에는 `COALESCE` 라 규칙의 강의실이 붙었다(A′3).
 * `ser` 별칭만 받는다 — 회차는 언제나 `o` 다.
 */
/**
 * 안내의 **종류 낱말** — 원문 §45 연동 줄 「mkGuide() 가 kind='quick'(강사 교체) 또는 'full'(첫 수업)로 생성」,
 * §44 머리 칩 「● 포괄 안내」 · §40 이력 「간이 안내 / 포괄 안내」 (g4 §44-4).
 * GUIDE 는 사유(`reason`)만 저장하고 종류는 사유에서 정해지므로 칸을 새로 두지 않는다 — 낱말은 여기 한 곳이다(D-R18).
 * 모르는 사유는 짓지 않는다(null).
 */
const GUIDE_KIND_LABEL: Readonly<Record<string, string>> = { new: '포괄 안내', teacher_change: '간이 안내' };
export const guideKindLabel = (reason: string): string | null => GUIDE_KIND_LABEL[reason] ?? null;

/**
 * §45 이력의 사건 셋(N-90 채택 · W11) — `hist` 의 안내 사건과 **그 사건 뒤의 안내 상태**.
 * 원문 §45 줄의 칩은 사건 뒤 상태 낱말이다(8/20 11:00 「발송 대기」 = 작성 · 8/19 16:40 「발송 완료」 = 발송).
 * 차례는 원장 흐름(작성 → 발송 → 확인)이고 날짜 머리의 칩도 이 차례다.
 */
export const GUIDE_HISTORY_EVENTS = [
  { action: 'guide_write', stateAfter: 'ready' },
  { action: 'guide_send', stateAfter: 'sent' },
  { action: 'guide_ack', stateAfter: 'read' },
] as const;

export const GUIDE_LESSON_JOINS = (ser: string): string => `LEFT JOIN sub sb ON sb.key=${ser}.sub_key
    LEFT JOIN kind k ON k.key=${ser}.kind_key
    LEFT JOIN room rm ON rm.id=CASE WHEN o.id IS NULL THEN ${ser}.room_id ELSE o.room_id END`;

/**
 * D-R5 누락 이벤트의 단일 계산식.
 * - SER_OCC의 현재 회차 투영과 그 회차의 학생 명단만 읽는다.
 * - 첫 참석 회차 또는 직전 참석 회차와 담당 강사가 달라진 회차만 이벤트다.
 * - GUIDE에는 재생성되는 SER_OCC.id 대신 `(ser_id,on_date,student_id,reason)`을 저장한다.
 *
 * 현황판(§34)의 안내 마크도 이 식을 쓴다 — 원문 「안내는 첫 수업이거나 강사가 바뀐 학생만 '필요'」.
 * 두 곳이 각자 판정하면 §45 에는 「안 한 것」인데 현황판은 「해당 없음」인 학생이 생긴다.
 */
export const GUIDE_EVENT_CTE = `WITH rostered AS (
  SELECT o.id AS source_occurrence_id, o.ser_id, o.on_date AS source_on,
         to_char(${kstDateOf('lower(o.span)')},'YYYY-MM-DD') AS event_on,
         o.teacher_id, ss.student_id, st.name AS student_name,
         t.name AS teacher_name, s.title AS ser_title,
         sb.name AS sub_name, k.name AS kind_name, ${START_MIN} AS start_min, rm.name AS room_name,
         ${kstAt('lower(o.span)')} AS start_at,
         -- 「첫 수업」·「직전 회차」는 **실제로 한 차례**다 — 옮긴 회차는 옮긴 시각 자리에 선다 (span 순 · MEETING-MOVE)
         row_number() OVER (PARTITION BY o.ser_id,ss.student_id ORDER BY lower(o.span),o.id) AS seq,
         lag(o.teacher_id) OVER (PARTITION BY o.ser_id,ss.student_id ORDER BY lower(o.span),o.id) AS previous_teacher_id
    FROM ser_occ o
    JOIN ser s ON s.id=o.ser_id
    JOIN ser_stu ss ON ss.ser_id=o.ser_id AND ${serStuOn('ss', 'o.on_date')}
    JOIN stu st ON st.id=ss.student_id
    LEFT JOIN staff t ON t.id=o.teacher_id
    ${GUIDE_LESSON_JOINS('s')}
    LEFT JOIN exc x ON x.ser_id=o.ser_id AND x.on_date=o.on_date
   WHERE NOT o.canceled
     AND NOT EXISTS (
       SELECT 1 FROM exc_stu_out xo
        WHERE xo.exc_id=x.id AND xo.student_id=ss.student_id
     )
), events AS (
  SELECT *, CASE
    WHEN seq=1 THEN 'new'
    WHEN previous_teacher_id IS DISTINCT FROM teacher_id THEN 'teacher_change'
    ELSE NULL
  END AS reason
  FROM rostered
)`;

/**
 * 이벤트 `e` 하나를 **덮는 안내**가 있는가 — `states` 가 주어지면 그 상태의 안내만 센다.
 *
 * 강사 교체(C93)는 규칙을 그 날짜에서 가르므로(D-R16 future) 새 규칙의 첫 회차가 「첫 수업」으로 잡힌다 —
 * 그 회차에 강사 교체 안내가 있으면 첫 수업 안내는 따로 필요 없다. 누락 판정(§45)과 현황판 마크(§34)가
 * 같은 조건을 쓴다. `$N` 자리 표시자를 받아 상태 배열을 넘긴다(없으면 상태를 보지 않는다).
 */
export function guideCoversEvent(statesParam?: string): string {
  return `EXISTS (
    SELECT 1 FROM guide g
     WHERE g.ser_id=e.ser_id AND g.event_on=e.source_on
       AND g.student_id=e.student_id
       AND (g.reason=e.reason OR g.reason='teacher_change')
       ${statesParam ? `AND g.state = ANY(${statesParam}::guide_state_t[])` : ''}
  )`;
}
