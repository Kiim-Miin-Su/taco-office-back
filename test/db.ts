/**
 * 테스트가 개발 DB 를 지우지 못하게 한다.
 *
 * 있었던 일 — `concurrency.spec.ts` 가 `beforeEach` 마다
 *   TRUNCATE ser_occ, inv, inv_line, rep RESTART IDENTITY CASCADE
 * 를 **개발 DB 에** 돌리고 있었다. `npm test` 한 번이면 시드가 사라지고,
 * 그다음 화면을 열면 시간표가 텅 비어 있다. `seed.spec.ts` 도 같이 깨진다.
 * 통과하던 이유는 「시드를 방금 넣었기 때문」이었을 뿐, 실행 순서에 달려 있었다.
 *
 * 그래서 두 가지를 나눈다.
 *   · 읽기만 하는 테스트(`seed.spec`)      → DATABASE_URL (시드가 든 개발 DB)
 *   · 표를 비우는 테스트(`concurrency.spec`) → TEST_DATABASE_URL (빈 스크래치 DB)
 *
 * 그리고 **안전벨트** — 스크래치가 아닌 DB 를 비우려 하면 그 자리에서 던진다.
 * 이름 규칙 하나로 막는 편이, 다음 사람이 URL 을 잘못 넣었을 때 조용히 지워지는 것보다 낫다.
 */

/** 개발 DB — 시드가 들어 있다. 읽기 전용으로 쓴다. */
export const DEV_URL = process.env.DATABASE_URL;

/** DB 이름만 바꾼 URL 을 만든다. */
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * 표를 비워도 되는 스크래치 DB.
 * TEST_DATABASE_URL 이 있으면 그것을, 없으면 개발 DB 이름에 `_test` 를 붙여 쓴다.
 */
export const TEST_URL = process.env.TEST_DATABASE_URL
  ?? (DEV_URL ? withDbName(DEV_URL, `${new URL(DEV_URL).pathname.slice(1)}_test`) : undefined);

/** URL 에서 DB 이름만 뽑는다. */
export function dbNameOf(url: string): string {
  return new URL(url).pathname.slice(1);
}

/**
 * 안전벨트 — 이 DB 를 비워도 되는가.
 * 이름이 `_test` 로 끝나지 않으면 던진다. 운영은 물론이고 개발 DB 도 막는다.
 */
export function assertScratch(url: string | undefined): string {
  if (!url) throw new Error('TEST_DATABASE_URL 이 없다 — ./scripts/dev-db.sh up 을 먼저 돌리세요');
  const name = dbNameOf(url);
  if (!/_test$/.test(name)) {
    throw new Error(
      `표를 비우는 테스트는 이름이 '_test' 로 끝나는 DB 에서만 돈다 (지금: '${name}').\n` +
      `개발 DB 를 가리키고 있으면 시드가 통째로 지워진다. TEST_DATABASE_URL 을 확인하세요.`,
    );
  }
  if (/prod|production/i.test(name)) throw new Error(`운영 DB 로 보인다: '${name}'`);
  return url;
}
