/** @file-guide
 * 목적: sql.ts — minOf, kstDateOf, kstMonthOf, START_MIN, END_MIN 등 (service)
 * 책임/재사용: 기존 lib/도메인 방어·Perm 함수를 재사용한다. 쓰기는 트랜잭션/DB 제약, 읽기는 권한별 projection으로 최종 검증한다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * SQL 조각 — **여러 모듈이 같은 식을 쓴다.**
 *
 * 시간대와 시각 형식이 여기 모여 있는 이유: D-R12 는 「관리자 화면의 모든 시각은 KST」인데,
 * 그 규칙이 서비스마다 흩어진 `to_char(...)` 안에 숨어 있으면 한 곳만 고쳐도 티가 안 난다.
 * 실제로 그렇게 새어 `+00` 이 내려가던 자리가 아홉 군데였다.
 */

// 시간대 상수는 lib/kst.ts 가 갖는다. 여기서 다시 적으면 두 벌이 된다.
export { KST } from './kst';
import { KST } from './kst';

/** KST 자정부터의 분 — `minOf('lower(o.span)')` */
export const minOf = (expr: string): string =>
  `(EXTRACT(HOUR FROM ${expr} AT TIME ZONE '${KST}') * 60`
  + ` + EXTRACT(MINUTE FROM ${expr} AT TIME ZONE '${KST}'))::int`;

/** KST 날짜 — 옮긴 EXC는 `on_date`와 실제 `span` 날짜가 다르므로 표시 날짜는 이것을 쓴다. */
export const kstDateOf = (expr: string): string => `(${expr} AT TIME ZONE '${KST}')::date`;

/**
 * 그 시각이 **KST 로 몇 월인가** — `'YYYY-MM'`.
 *
 * 청구서가 「8월분」인지는 UTC 가 아니라 KST 로 갈린다. 8월 31일 23시 수업은 UTC 로는 9월이다.
 * 시간대를 쿼리마다 적으면 그런 한 줄이 어딘가 하나 빠진다 (D-R12 — 시간대는 한 곳에서 정한다).
 */
export const kstMonthOf = (expr: string): string => `to_char(${expr} AT TIME ZONE '${KST}', 'YYYY-MM')`;

/** `ser_occ` 를 `o` 로 별칭 붙였을 때의 시작·끝 분. 둘 다 수업 시작일의 KST 자정 기준이다. */
export const START_MIN = minOf('lower(o.span)');
// API가 허용하는 24:00 종료는 다음 날짜의 00:00으로 저장된다. 시각만 뽑으면 1440이 0이 되어
// 길이가 음수가 되고 리포트·출결이 일찍 열린다. 실제 span 날짜 차이를 더해 이동 예외도 보존한다.
export const END_MIN = `(${minOf('upper(o.span)')} + 1440 * (`
  + `${kstDateOf('upper(o.span)')} - ${kstDateOf('lower(o.span)')}))`;

/**
 * 화면에 내려보내는 시각 — **언제나 KST 오프셋이 붙은 ISO** 다.
 *
 * `to_char(x, '…OF')` 만 쓰면 서버 세션 시간대가 그대로 나온다. 컨테이너는 UTC 라
 * `+00` 이 붙고, 화면은 그것을 그대로 믿어 아홉 시간 어긋난 시각을 보여 준다.
 * 그래서 KST 로 옮긴 뒤 오프셋을 **글자로** 붙인다.
 */
export const kstAt = (expr: string): string =>
  `to_char(${expr} AT TIME ZONE '${KST}', 'YYYY-MM-DD"T"HH24:MI:SS') || '+09:00'`;

/**
 * 겹침 판정 구간 — **DB 의 EXCLUDE 와 같은 연산자**(`span &&`)를 쓴다.
 * 분으로 되돌려 비교하면 자정을 넘는 회차에서 둘의 답이 갈린다.
 */
/** `HH24:MI` — 현황판처럼 시각을 글자로 바로 쓰는 곳 */
export const hhmmOf = (expr: string): string =>
  `to_char(${expr} AT TIME ZONE '${KST}', 'HH24:MI')`;

export const spanOf = (date: string, from: string, to: string): string =>
  `tstzrange(`
  + `(${date}::date + make_interval(mins => ${from})) AT TIME ZONE '${KST}',`
  + ` (${date}::date + make_interval(mins => ${to})) AT TIME ZONE '${KST}', '[)')`;

/**
 * SQL `IN (…)` 목록 — 낱말 집합 하나를 여러 질의가 그대로 쓰게 한다 (D-R18).
 *
 * 상태 칸은 enum 이라 배열 파라미터(`= ANY($1::text[])`)로 넘기면 캐스팅이 한 겹 더 붙는다.
 * 여기서 넘어오는 것은 **코드 안의 상수 낱말**뿐이므로 목록으로 펼친다.
 */
export const sqlWordList = (words: readonly string[]): string => words.map((w) => `'${w}'`).join(', ');

/**
 * `UPDATE`·`DELETE` 의 `RETURNING` 은 드라이버가 **`[rows, count]` 로 감싼다** (`SELECT`·`INSERT` 는 rows 그대로).
 *
 * 이걸 모르면 `rows.length > 0` 이 **언제나 참**이 된다 — 한 줄도 안 바뀌어도 배열 길이가 2 라서다.
 * 실제로 서랍의 「알림 읽음」·「할 일 체크」가 **남의 행에도 200 을 돌려주고 있었다**(바꾸지는 않았지만
 * 「없다」로 답해야 할 자리에서 성공이라고 말했다). 컨설팅 쪽은 같은 함정을 먼저 만나 갱신과 조회를
 * 나눠 두었다 — 여기서는 모양에 기대지 않고 **세는 함수 하나**로 막는다.
 */
export function writtenRows<T = unknown>(res: unknown): T[] {
  if (Array.isArray(res) && res.length === 2 && Array.isArray(res[0]) && typeof res[1] === 'number') {
    return res[0] as T[];
  }
  return (Array.isArray(res) ? res : []) as T[];
}

/** `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` 한 문장에서 읽어 낸 것 */
export interface CheckConstraintSql {
  table: string;
  name: string;
  expr: string;
}

/**
 * 실패한 제약 추가 문장에서 **표·제약 이름·CHECK 식**을 꺼낸다.
 *
 * 쓰는 곳은 마이그레이션 예행(`scripts/migration-dryrun.ts`)이다 — 제약이 거절한 행을
 * `WHERE NOT (식)` 으로 되물으려면 식이 필요한데, Postgres 에러는 **제약 이름만** 준다.
 *
 * 정규식을 파일 안에 묻어 뒀다가 조용히 안 맞은 적이 있다(여러 줄로 적힌 `CHECK` 를 못 읽었다).
 * 안 맞으면 `null` 을 돌려주고 부르는 쪽이 「못 읽었다」고 **말한다** — 틀린 식으로 세지 않는다.
 */
export function parseCheckConstraint(sql: string): CheckConstraintSql | null {
  const m = /ALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?\s+ADD\s+CONSTRAINT\s+"?(\w+)"?\s+CHECK\s*\(([\s\S]+)\)\s*(?:NOT\s+VALID)?\s*;?\s*$/i
    .exec(sql.trim());
  if (!m) return null;
  const [, table, name, expr] = m;
  if (expr.trim() === '') return null;
  return { table, name, expr: expr.replace(/\s+/g, ' ').trim() };
}

/**
 * 학생이 그 날짜에 **휴원 중**인가 (C92-c · C-36/C-37). 시간표·명단·청구가 같은 판정을 쓴다 —
 * 기간 안의 회차는 그 학생에게 「그날만 빠짐」과 같다. 복귀하면 to_date 가 당겨져 저절로 돌아온다.
 * @param student 학생 id 표현식 (예: `ss.student_id`) · @param date 날짜 표현식 (예: `o.on_date`)
 */
export const stuPausedOn = (student: string, date: string): string =>
  `EXISTS (SELECT 1 FROM stu_pause sp WHERE sp.student_id = ${student}
             AND ${date} >= sp.from_date AND (sp.to_date IS NULL OR ${date} <= sp.to_date))`;

/**
 * 명단 행(SER_STU)이 **그 날짜에 유효**한가 (C94-c · H-80 · N-136 · N-50 ①). 기간이 없으면(둘 다 NULL) 언제나 유효 —
 * 지금까지의 명단과 같다. 수강 종료는 `to_date` 를 적을 뿐 행을 지우지 않으므로, 지난 회차의 명단·청구는 그대로고
 * 그 뒤 회차에서만 빠진다. 시간표·§54·청구서·단가 구간(인원)이 이 한 조각을 읽는다.
 * @param alias SER_STU 별칭 (예: `ss`) · @param date 날짜 표현식 (예: `o.on_date`)
 */
export const serStuOn = (alias: string, date: string): string =>
  `((${alias}.from_date IS NULL OR ${date} >= ${alias}.from_date)
    AND (${alias}.to_date IS NULL OR ${date} <= ${alias}.to_date))`;

/** 그 날짜에 이미 **수강 종료**된 명단 행인가 — 카드·명단 칩용 (유효 판정은 `serStuOn`) */
export const serStuEndedOn = (alias: string, date: string): string =>
  `(${alias}.to_date IS NOT NULL AND ${date} > ${alias}.to_date)`;
