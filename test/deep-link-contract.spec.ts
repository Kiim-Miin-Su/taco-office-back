/** @file-guide
 * 목적: deep-link-contract.spec.ts — 서버가 알림(NOTI) · 이동(go) · 시드에 적는 화면 주소가 **front 가 실제로 읽는 경로 · 질의 키**인가
 * 책임/재사용: 소스를 읽어 주소 글자를 모으고, front 화면이 읽는 키 표(아래 FRONT)와 대조한다. DB 없이 돈다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md · docs/report/GO-LIVE-GAP-2026-09-29.md §5-3
 */

/**
 * P1 CROSS-CUT · DELIVERY 의 「deep link」 — 알림을 눌렀는데 **엉뚱한 탭**이 열리거나 없는 경로(404)로 가면, 수신자는 무엇을 하라는
 * 알림인지 찾지 못한다. 2026-09-29 전수에서 찾은 것:
 *   · 마케팅 피드백 알림 `/ops?mkt` — 운영 화면은 `tab` 만 읽어 **할 일 탭**이 열렸다(→ `/ops?tab=mkt`).
 *   · §14/§75 「줌 계정 미배정」 줄 `/schedule?d=…` — 스케줄은 `date` 만 읽어 **오늘**이 열렸다(→ `date`).
 *   · 시드 알림 `/ops/complaints` · `/ops/marketing` — 없는 경로(404)였다.
 *
 * FRONT 표는 front 화면이 읽는 키의 **사본**이다(`useSearchParams().get(…)` · 2026-09-29 기준). 화면이 키를 바꾸면 이 표와 서버 주소를
 * 함께 고친다 — 표만 고치면 이 시험이 뜻을 잃는다.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** 경로 → 그 화면이 읽는 질의 키 (front `src/app/**\/page.tsx`) */
const FRONT: Record<string, readonly string[]> = {
  '/ops': ['tab', 'plan', 'request', 'meeting', 'cpl', 'view'],
  '/schedule': ['date', 'serId', 'onDate', 'changeRequest', 'studentId', 'myExpense'], // myExpense — §75 지출 갈래의 되돌아온 것(H-84) → 서랍 「내 지출 신청」
  '/reports': ['section', 'review', 'serId', 'onDate'],
  '/accounting': ['tab', 'month', 'invId'],
  '/books': ['tab', 'pack'],
  '/board': ['date'],
  '/exec': ['view', 'date', 'rpt'], // rpt 는 §75 가 싣는 서버 식별자 — 화면은 view · date 로 연다(exec page 주석)
  '/consulting': ['id'],
  '/intake': ['lead'],
  '/teacher': ['meeting', 'req'], // req 는 요청 결과 알림의 표지 — 강사 홈이 그대로 연다(값 없음)
  '/teacher/guides': ['guideId'],
  '/teacher/suggestions': [],
  '/teacher/history': [],
  '/teacher/unavailable': [],
  '/guides': [],
  '/gpa': [],
  '/zoom': [],
  '/programs': [],
  '/phrases': [],
  '/permissions': [],
};
/** `/reports/:section` 은 옛 주소 호환 경로다(front `reports/[section]` 이 탭 주소로 돌린다) */
const REPORT_SECTIONS = ['unwritten', 'weekly', 'deliveries', 'history'];
const ROUTE_HEADS = Object.keys(FRONT).map((p) => p.slice(1).split('/')[0]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
  });
}

/** 소스의 주소 글자 — 주석 줄과 문서 문장(띄어쓰기가 든 글자)은 뺀다. API 경로(`/ops/leads/…` 같은 컨트롤러 주소)도 뺀다 */
function linkLiterals(): Array<{ file: string; link: string }> {
  const out: Array<{ file: string; link: string }> = [];
  const head = new RegExp(`^/(${[...new Set(ROUTE_HEADS)].join('|')})([/?]|$)`);
  for (const f of ['src/modules', 'src/lib', 'src/seed'].flatMap((d) => files(join(__dirname, '..', d)))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      for (const m of line.matchAll(/(['`])(\/[^'`\s]*)\1/g)) {
        const link = m[2];
        if (!head.test(link) || link.includes('{id}') || link.includes('…')) continue;
        out.push({ file: f.slice(f.indexOf('src/')), link });
      }
    }
  }
  return out;
}

/** 이 링크가 front 가 여는 주소인가 — 아니면 까닭 */
function problem(link: string): string | null {
  const [path, query = ''] = link.split('?');
  const bare = path.replace(/\$\{[^}]*\}/g, 'X');
  if (bare.startsWith('/reports/')) {
    const section = bare.split('/')[2];
    return REPORT_SECTIONS.includes(section) ? null : `없는 리포트 칸 ${section}`;
  }
  const keys = FRONT[bare];
  if (!keys) return `front 에 없는 경로 ${bare}`;
  const unread = query.split('&').filter(Boolean).map((kv) => kv.split('=')[0]).filter((k) => k && !keys.includes(k));
  return unread.length ? `화면이 읽지 않는 키 ${unread.join(', ')}` : null;
}

describe('deep link — 서버가 적는 화면 주소는 front 가 읽는 경로 · 키다 (P1 CROSS-CUT · DELIVERY)', () => {
  const links = linkLiterals();

  it('주소 글자를 실제로 모았다 — 비면 이 시험이 아무것도 안 본 것이다', () => {
    expect(links.length).toBeGreaterThan(40);
    expect(links.map((l) => l.link)).toEqual(expect.arrayContaining(['/ops?tab=complaint', '/reports/unwritten']));
  });

  it('모든 주소가 front 의 경로이고, 질의 키는 그 화면이 읽는 키다', () => {
    const bad = links.map((l) => ({ ...l, why: problem(l.link) })).filter((l) => l.why);
    expect(bad).toEqual([]);
  });

  it('판정이 실제로 거른다 — 옛 결함 모양은 걸린다', () => {
    expect(problem('/ops?mkt')).toMatch(/읽지 않는 키 mkt/);
    expect(problem('/schedule?d=${String(r.on_date)}')).toMatch(/읽지 않는 키 d/);
    expect(problem('/ops/complaints')).toMatch(/없는 경로/);
    expect(problem('/ops?tab=mkt')).toBeNull();
  });
});
