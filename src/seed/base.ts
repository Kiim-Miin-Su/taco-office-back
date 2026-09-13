/** @file-guide
 * 목적: base.ts — SEED_TODAY, AUTHORED_ON, addDays, daysBetween, SEED_SHIFT 등 (seed)
 * 책임/재사용: 격리 개발/테스트 자료 생성용이다. 기존 enum/키/참조 제약을 재사용하고 운영 데이터를 임의 수정하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 기준 정보 — 사람보다 먼저 있어야 하는 것들.
 * 코드표(KIND·SUB)는 명세서 v2 §85·§86 의 값을 그대로 쓴다. 색은 프론트 tokens.css 와 같은 값이다.
 */
/**
 * 시드의 기준일.
 *
 * 고정 상수로 두면 시간이 지나면서 데이터가 과거로 밀려 「오늘 수업이 없습니다」가 된다.
 * 그래서 기본은 **오늘(KST)** 이고, 재현이 필요할 때만 SEED_TODAY 로 못 박는다.
 *   SEED_TODAY=2026-08-28 npm run seed -- --reset
 */
function todayKst(): string {
  const now = new Date();
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
export const SEED_TODAY = process.env.SEED_TODAY ?? todayKst();

/* ══ 날짜가 오늘을 따라오게 한다 ═════════════════════════════════════
   회차·리포트는 SEED_TODAY 기준으로 만들어지는데, 학생·등록·상담은 **절대 날짜**로
   적혀 있었다. 그래서 시간이 지나면 둘이 벌어진다 —
   실제로 「이번 달 등록 0건」이 나왔다. 상담은 10건 들어왔는데 등록은 0인 화면이다.

   고치는 방법은 둘 중 하나다: 날짜를 전부 상대값으로 다시 적거나,
   **적을 때 기준으로 삼은 날**을 밝히고 그만큼 통째로 미는 것.
   뒤쪽을 택한다 — 리터럴이 읽히는 채로 남고, 미는 자리는 한 곳이다. */

/** 이 시드의 날짜들을 적을 때 기준으로 삼은 날 */
export const AUTHORED_ON = '2026-08-29';

export function addDays(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
}

/** AUTHORED_ON → SEED_TODAY 만큼의 차이. 오늘 시드를 돌리면 0 이다. */
export const SEED_SHIFT = daysBetween(AUTHORED_ON, SEED_TODAY);

/** 적어 둔 날짜를 오늘 기준으로 민다. 하루 차이도 없이 그대로 재현된다. */
export const rel = (iso: string): string => (SEED_SHIFT === 0 ? iso : addDays(iso, SEED_SHIFT));

/**
 * 수업 종류 8종 — **명세서 v2 슬라이드 88 의 표 그대로**.
 *
 * 이름·색·정원·분류는 원문 표에서 한 칸씩 옮긴 것이다. 한동안 이름이 여섯 개 달랐고
 * (「정규 수업」·「모의고사」·「GPA 관리」·「자습 관리」·「진단 평가」), 정원 다섯 개와
 * `consulting` 의 분류도 달랐다. 이름이 다르면 원문 대조가 매번 번역부터 시작된다 (C54).
 *
 * `rep`·`repForm` 은 원문 표에 없는 우리 칸이다 — 리포트 대상 여부(D-R14)를 종류에 매단 것이다.
 *
 * ⚠️ `mock` · `gpa` 의 정원은 **원문이 1 인데 여기는 아직 옛 값**이다. 시드의
 * 「모의 SAT 정기」가 4인이고 GPA 회차가 2인이라, 정원을 1 로 내리면 그 행들이 정원을 넘는다.
 * 원문의 이름도 「모의수업」이라 **1:1 체험 수업**을 가리키는데 우리 시드는 단체 모의고사다 —
 * 개념이 갈렸다. 시드를 쪼개면 리포트·정산·GPA 소비 이력이 함께 움직여서 N-30 으로 올렸다.
 */
export const KINDS = [
  { key: 'class',      name: '수업',     color: '#4A5461', cap: 4,  grp: 'lesson',  rep: true,  repForm: 'dev',    sort: 1 },
  { key: 'mock',       name: '모의수업',  color: '#BC7855', cap: 20, grp: 'lesson',  rep: true,  repForm: 'assess', sort: 2 },
  { key: 'gpa',        name: 'GPA',      color: '#816BB0', cap: 4,  grp: 'lesson',  rep: true,  repForm: 'dev',    sort: 3 },
  { key: 'study',      name: '자습',     color: '#59988B', cap: 12, grp: 'lesson',  rep: false, repForm: null,     sort: 4 },
  { key: 'consult',    name: '상담',     color: '#52969C', cap: 3,  grp: 'intake',  rep: false, repForm: null,     sort: 5 },
  { key: 'diagx',      name: '진단고사',  color: '#6F798A', cap: 8,  grp: 'intake',  rep: true,  repForm: 'assess', sort: 6 },
  { key: 'consulting', name: '컨설팅',    color: '#AC6287', cap: 3,  grp: 'intake',  rep: true,  repForm: 'dev',    sort: 7 },
  { key: 'meeting',    name: '회의',     color: '#736CAE', cap: 10, grp: 'meeting', rep: false, repForm: null,     sort: 8 },
] as const;

/**
 * 과목 21종 — **명세서 v2 슬라이드 89 의 표 그대로**.
 *
 * 이름과 색은 원문 표에서 옮겼다. 한동안 열세 개 이름이 달랐다 —
 * 「Vocab」(원문 Vocabulary) · 「AP Chemistry」(AP Chem) · 「자습실」(학습실) ·
 * 「GPA Care」(GPA 관리) · 「모의 SAT/MAP」(모의수업 A/B) · 「신규 상담」(입학 상담) ·
 * 「입시 컨설팅」(진학 컨설팅) · 회의 다섯 개의 어순(「회의 · 기획」 → 「기획 회의」).
 * 원문 §59 컷의 「학습실 하루 · 30초 릴스」와 §23 컷의 「모의수업 A 주1」이 같은 말을 한다 (C54).
 *
 * **키는 원문과 구분자가 다르다** — 원문은 `map_read`, 여기는 `map-read` 다. 키는 화면에
 * 안 보이고 `ser`·`lib`·`rate` 등 여러 표의 값으로 박혀 있어 바꾸면 데이터 이관이 된다.
 * 이름을 맞추는 것과 키를 바꾸는 것은 다른 일이라 키는 그대로 뒀다 (N-30).
 */
export const SUBS = [
  { key: 'map-read',   name: 'MAP Reading',   color: '#A85764' },
  { key: 'map-math',   name: 'MAP Math',      color: '#B57046' },
  { key: 'sat-read',   name: 'SAT Reading',   color: '#4A827B' },
  { key: 'sat-math',   name: 'SAT Math',      color: '#9C7A38' },
  { key: 'writing',    name: 'Writing',       color: '#736CAE' },
  { key: 'vocab',      name: 'Vocabulary',    color: '#6F8F52' },
  { key: 'ap-chem',    name: 'AP Chem',       color: '#5677A5' },
  { key: 'interview',  name: 'Interview',     color: '#AC6287' },
  { key: 'read-lab',   name: 'Reading Lab',   color: '#568A9F' },
  { key: 'study-room', name: '학습실',         color: '#59988B' },
  { key: 'gpa-care',   name: 'GPA 관리',       color: '#816BB0' },
  { key: 'mock-sat',   name: '모의수업 A',     color: '#BE8551' },
  { key: 'mock-map',   name: '모의수업 B',     color: '#8D6B48' },
  { key: 'diag',       name: '진단고사',       color: '#6F798A' },
  { key: 'intake',     name: '입학 상담',      color: '#52969C' },
  { key: 'admissions', name: '진학 컨설팅',    color: '#955675' },
  { key: 'mt-pl',      name: '기획 회의',      color: '#6E6098' },
  { key: 'mt-cs',      name: '컨설팅 회의',    color: '#477785' },
  { key: 'mt-mk',      name: '마케팅 회의',    color: '#9A5B71' },
  { key: 'mt-dv',      name: '개발 회의',      color: '#546FA2' },
  { key: 'mt-pg',      name: '일반 회의',      color: '#856C4A' },
] as const;

/** 강의실 — 3지점 */
export const ROOMS = [
  { id: 1, branch: '강남', name: '2층 A강의실', capacity: 6 },
  { id: 2, branch: '강남', name: '2층 B강의실', capacity: 4 },
  { id: 3, branch: '강남', name: '3층 컨설팅룸', capacity: 3 },
  { id: 4, branch: '강남', name: '3층 회의실',   capacity: 12 },
  { id: 5, branch: '송도', name: '송도 1강의실', capacity: 6 },
  { id: 6, branch: '송도', name: '송도 2강의실', capacity: 4 },
  { id: 7, branch: '제주', name: '제주 강의실',  capacity: 6 },
  { id: 8, branch: '강남', name: '자습실',       capacity: 20 },
];

/** 줌 계정 5개 — 계정 하나는 같은 시간에 회의 하나만 (D-R43) */
export const ZACCS = [
  { id: 1, label: 'TN Zoom 1', loginEmail: 'zoom1@tnacademy.kr', meetingId: '820 1111 0001' },
  { id: 2, label: 'TN Zoom 2', loginEmail: 'zoom2@tnacademy.kr', meetingId: '820 1111 0002' },
  { id: 3, label: 'TN Zoom 3', loginEmail: 'zoom3@tnacademy.kr', meetingId: '820 1111 0003' },
  { id: 4, label: 'TN Zoom 4', loginEmail: 'zoom4@tnacademy.kr', meetingId: '820 1111 0004' },
  { id: 5, label: 'TN Zoom 5', loginEmail: 'zoom5@tnacademy.kr', meetingId: '820 1111 0005' },
];

/**
 * 구성원 5명 — 대표 1 · 관리자 1 · 매니저 2 · 강사 1 (대표 지시 2026-09-14).
 * 신규 개발 DB의 표본이다. 운영 계정/이력의 삭제·합병 매핑으로 사용하지 않는다.
 * 직함(title)은 표시용이고 권한은 role 에서 파생한다 (D-R39).
 * **교수실장 직함은 존재하지 않는다** — 안내 글에서도 쓰지 않는다.
 * 비밀번호는 전부 `taco1234!` — 개발용이라 같게 둔다.
 */
export const STAFF = [
  { id: 1, name: '김민선', email: 'ceo@tnacademy.kr',    role: 'ceo',     title: '대표',       hiredOn: '2019-03-02' },
  { id: 2, name: '김민수', email: 'admin@tnacademy.kr',  role: 'admin',   title: '관리자',     hiredOn: '2021-01-04' },
  { id: 3, name: '김범준', email: 'head@tnacademy.kr',   role: 'manager', title: '매니저',     hiredOn: '2020-06-15' },
  { id: 4, name: '강민지', email: 'coord@tnacademy.kr',  role: 'manager', title: '매니저',     hiredOn: '2022-09-01' },
  { id: 7, name: '김재훈', email: 't02@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2023-03-06' },
] as const;

/** 시급 — 강사만. 대표만 본다 (D-R39 canSeeProfit) */
export const WAGES: Array<{ staffId: number; rate: number; fromDate: string }> = [
  { staffId: 7, rate: 40000, fromDate: '2025-03-01' },
];

/** 프로그램 단가 — 명세서 §54 수업료 계산 */
export const RATES = [
  { kindKey: 'class',      subKey: 'ap-chem',   unitPrice: 80000, fromDate: '2026-01-01' },
  // N-17 인원 구간 표본 — 인원↑ 단가↓·총액↑ (80k → 90k → 102k → 108k)
  { kindKey: 'class',      subKey: 'ap-chem',   heads: 2, unitPrice: 45000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'ap-chem',   heads: 3, unitPrice: 34000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'ap-chem',   heads: 4, unitPrice: 27000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'sat-math',  unitPrice: 80000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'writing',   unitPrice: 60000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'writing',   heads: 2, unitPrice: 33000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'writing',   heads: 3, unitPrice: 24000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'map-math',  unitPrice: 60000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'map-read',  unitPrice: 60000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'sat-read',  unitPrice: 70000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'vocab',     unitPrice: 35000, fromDate: '2026-01-01' },
  { kindKey: 'study',      subKey: 'study-room', unitPrice: 20000, fromDate: '2026-01-01' },
  { kindKey: 'diagx',      subKey: 'diag',      unitPrice: 50000, fromDate: '2026-01-01' },
  { kindKey: 'consulting', subKey: 'admissions', unitPrice: 180000, fromDate: '2026-01-01' },
  { kindKey: 'gpa',        subKey: 'gpa-care',  unitPrice: 55000, fromDate: '2026-01-01' },
  { kindKey: 'mock',       subKey: 'mock-sat',  unitPrice: 45000, fromDate: '2026-01-01' },
];

/** 시간대 그룹 — 구성원 · 시간대 화면(§17) */
export const TZGS = [
  { id: 1, name: '한국 (KST)', tz: 'Asia/Seoul' },
  { id: 2, name: '미국 동부',   tz: 'America/New_York' },
  { id: 3, name: '미국 서부',   tz: 'America/Los_Angeles' },
];
