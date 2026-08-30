/**
 * 「지금 어느 DB 를 보고 있는가」를 판정하는 **한 곳**.
 *
 * 배포를 앞두고 이것이 필요해진 이유: 기존 시드 안전벨트는 연결 문자열에
 * `prod` 라는 글자가 있는지만 봤다. 그런데 Neon 주소는 이렇게 생겼다 —
 *
 *     postgresql://…@ep-quiet-frost-a1b2c3.ap-northeast-2.aws.neon.tech/taco?sslmode=require
 *
 * `prod` 도 `production` 도 없다. **운영 DB 를 통째로 지우는 시드가 그냥 돌았을 것이다.**
 * 그래서 「위험해 보이면 막는다」가 아니라 **「안전한 것이 확실할 때만 통과」**로 뒤집는다.
 */

export type Target = 'local' | 'managed' | 'unknown';

/** 관리형 Postgres 호스트 — 이 중 하나면 남의 서버다 */
const MANAGED = [
  'neon.tech', 'supabase.co', 'supabase.com', 'rds.amazonaws.com',
  'render.com', 'railway.app', 'planetscale', 'cockroachlabs.cloud',
  'azure.com', 'digitalocean.com', 'timescale.com', 'aiven',
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];

export interface TargetInfo {
  kind: Target;
  host: string;
  db: string;
  /** 사람이 읽을 한 줄 — 로그와 오류 메시지가 같은 문장을 쓰게 한다 */
  label: string;
}

export function describeTarget(url: string | undefined): TargetInfo {
  if (!url) return { kind: 'unknown', host: '', db: '', label: 'DATABASE_URL 이 없습니다' };
  let u: URL;
  try { u = new URL(url); } catch { return { kind: 'unknown', host: '', db: '', label: '연결 문자열을 읽지 못했습니다' }; }

  const host = u.hostname;
  const db = u.pathname.replace(/^\//, '') || '(이름 없음)';
  const kind: Target = LOCAL_HOSTS.includes(host) ? 'local'
    : MANAGED.some((m) => host.includes(m)) ? 'managed'
    : 'unknown';

  const what = { local: '내 컴퓨터', managed: '관리형(원격)', unknown: '알 수 없는 호스트' }[kind];
  return { kind, host, db, label: `${what} · ${host} · DB "${db}"` };
}

/**
 * 표를 지우거나 통째로 채우는 작업을 허락할지 판정한다.
 *
 * 통과 조건은 **둘 중 하나뿐**이다.
 *   ① 대상이 내 컴퓨터다
 *   ② 사람이 `SEED_I_KNOW` 에 **DB 이름을 정확히 적어** 스스로 확인했다
 *
 * 「운영으로 보이면 막는다」가 아니라 「안전한 것이 확실할 때만 통과」다.
 * 앞의 방식은 새 호스트가 생길 때마다 조용히 뚫린다 — 실제로 Neon 이 그랬다.
 */
export function assertWritableTarget(url: string | undefined, what = '이 작업'): TargetInfo {
  const t = describeTarget(url);
  if (t.kind === 'unknown' && !t.host) throw new Error(`DATABASE_URL 이 없습니다 — ${what}을 할 수 없습니다.`);
  if (t.kind === 'local') return t;

  const ack = (process.env.SEED_I_KNOW ?? '').trim();
  if (ack && ack === t.db) return t;

  throw new Error(
    `${what}은 내 컴퓨터의 DB 에서만 돕니다.\n`
    + `  지금 가리키는 곳: ${t.label}\n`
    + '  이 DB 의 표를 비우고 다시 채우려는 것이 **확실하다면**,\n'
    + `  DB 이름을 그대로 적어 다시 도세요:  SEED_I_KNOW="${t.db}" npm run seed -- --reset\n`
    + '  (운영 데이터는 N-16 이지 시드가 아닙니다 — 시드는 개발·시연용입니다.)',
  );
}
