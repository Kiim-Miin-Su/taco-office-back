/**
 * KST — **시간대가 정의되는 단 하나의 자리** (D-R12).
 *
 * SQL 쪽 조각은 `lib/sql.ts` 에 있고, 그 파일도 여기서 `KST` 를 가져다 쓴다.
 * 자바스크립트로 「오늘」을 구하는 일은 여기 있다.
 *
 * 왜 모았는가 — 배포 직전 리뷰에서 `new Date(Date.now() + 9*3600*1000)` 이
 * 백엔드 다섯 곳 · 프런트 두 곳에 흩어져 있는 것이 나왔다. 자정 언저리에서
 * 한 곳만 고치면 서랍과 운영 탭이 같은 할 일을 두고 「지났다 / 안 지났다」로 갈린다.
 */
export const KST = 'Asia/Seoul';

/** 자정부터 9시간 밀어 UTC 로 읽으면 그날의 KST 날짜가 된다 */
const KST_MS = 9 * 3600 * 1000;

/** 오늘 (KST) — `2026-08-30` */
export const todayKst = (now: number = Date.now()): string =>
  new Date(now + KST_MS).toISOString().slice(0, 10);

/** 지금 몇 분 (KST 자정 기준) — 캘린더의 빨간 현재 시각 줄이 쓴다 */
export const nowMinKst = (now: number = Date.now()): number => {
  const d = new Date(now + KST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** `2026-08-30` 에서 n일 — 음수면 과거 */
export const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/**
 * 기한이 며칠 지났는가. 안 지났으면 0.
 * **끝난 일에는 쓰지 않는다** — 완료한 할 일은 늦었든 아니든 0으로 보여 준다.
 */
export const overdueDays = (dueOn: string | null | undefined, today = todayKst()): number => {
  if (!dueOn) return 0;
  const d = (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueOn}T00:00:00Z`).getTime()) / 86400000;
  return d > 0 ? Math.floor(d) : 0;
};
