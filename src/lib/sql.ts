/**
 * SQL 조각 — **여러 모듈이 같은 식을 쓴다.**
 *
 * 시간대와 시각 형식이 여기 모여 있는 이유: D-R12 는 「관리자 화면의 모든 시각은 KST」인데,
 * 그 규칙이 서비스마다 흩어진 `to_char(...)` 안에 숨어 있으면 한 곳만 고쳐도 티가 안 난다.
 * 실제로 그렇게 새어 `+00` 이 내려가던 자리가 아홉 군데였다.
 */

/** 하나뿐인 시간대 (D-R12) */
export const KST = 'Asia/Seoul';

/** KST 자정부터의 분 — `minOf('lower(o.span)')` */
export const minOf = (expr: string): string =>
  `(EXTRACT(HOUR FROM ${expr} AT TIME ZONE '${KST}') * 60`
  + ` + EXTRACT(MINUTE FROM ${expr} AT TIME ZONE '${KST}'))::int`;

/** `ser_occ` 를 `o` 로 별칭 붙였을 때의 시작·끝 분 */
export const START_MIN = minOf('lower(o.span)');
export const END_MIN = minOf('upper(o.span)');

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
export const spanOf = (date: string, from: string, to: string): string =>
  `tstzrange(`
  + `(${date}::date + make_interval(mins => ${from})) AT TIME ZONE '${KST}',`
  + ` (${date}::date + make_interval(mins => ${to})) AT TIME ZONE '${KST}', '[)')`;
