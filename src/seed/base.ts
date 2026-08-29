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

/** 수업 종류 8종 — 명세서 v2 §85 */
export const KINDS = [
  { key: 'class',      name: '정규 수업',   color: '#4A5461', cap: 4, grp: 'lesson',  rep: true,  repForm: 'dev',    sort: 1 },
  { key: 'mock',       name: '모의고사',     color: '#BC7855', cap: 20, grp: 'lesson', rep: true,  repForm: 'assess', sort: 2 },
  { key: 'gpa',        name: 'GPA 관리',    color: '#816BB0', cap: 4, grp: 'lesson',  rep: true,  repForm: 'dev',    sort: 3 },
  { key: 'study',      name: '자습 관리',    color: '#59988B', cap: 20, grp: 'lesson', rep: false, repForm: null,     sort: 4 },
  { key: 'consult',    name: '상담',        color: '#52969C', cap: 2, grp: 'intake',  rep: false, repForm: null,     sort: 5 },
  { key: 'diagx',      name: '진단 평가',    color: '#6F798A', cap: 8, grp: 'intake',  rep: true,  repForm: 'assess', sort: 6 },
  { key: 'consulting', name: '컨설팅',      color: '#AC6287', cap: 3, grp: 'lesson',  rep: true,  repForm: 'dev',    sort: 7 },
  { key: 'meeting',    name: '회의',        color: '#736CAE', cap: 12, grp: 'meeting', rep: false, repForm: null,    sort: 8 },
] as const;

/** 과목 21종 — 명세서 v2 §86 */
export const SUBS = [
  { key: 'map-read',   name: 'MAP Reading',   color: '#A85764' },
  { key: 'map-math',   name: 'MAP Math',      color: '#B57046' },
  { key: 'sat-read',   name: 'SAT Reading',   color: '#4A827B' },
  { key: 'sat-math',   name: 'SAT Math',      color: '#9C7A38' },
  { key: 'writing',    name: 'Writing',       color: '#736CAE' },
  { key: 'vocab',      name: 'Vocab',         color: '#6F8F52' },
  { key: 'ap-chem',    name: 'AP Chemistry',  color: '#5677A5' },
  { key: 'interview',  name: 'Interview',     color: '#AC6287' },
  { key: 'read-lab',   name: 'Reading Lab',   color: '#568A9F' },
  { key: 'study-room', name: '자습실',         color: '#59988B' },
  { key: 'gpa-care',   name: 'GPA Care',      color: '#816BB0' },
  { key: 'mock-sat',   name: '모의 SAT',      color: '#BE8551' },
  { key: 'mock-map',   name: '모의 MAP',      color: '#8D6B48' },
  { key: 'diag',       name: '진단고사',       color: '#6F798A' },
  { key: 'intake',     name: '신규 상담',      color: '#52969C' },
  { key: 'admissions', name: '입시 컨설팅',    color: '#955675' },
  { key: 'mt-pl',      name: '회의 · 기획',    color: '#6E6098' },
  { key: 'mt-cs',      name: '회의 · 컨설팅',  color: '#477785' },
  { key: 'mt-mk',      name: '회의 · 마케팅',  color: '#5C7A9E' },
  { key: 'mt-dv',      name: '회의 · 개발',    color: '#4F7F6B' },
  { key: 'mt-pg',      name: '회의 · 일반',    color: '#7A7A8C' },
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
 * 구성원 16명 — 대표 1 · 관리자 1 · 매니저 1 · 실장 2 · 강사 11.
 * 직함(title)은 표시용이고 권한은 role 에서 파생한다 (D-R39).
 * 비밀번호는 전부 `taco1234!` — 개발용이라 같게 둔다.
 */
export const STAFF = [
  { id: 1,  name: '김민선', email: 'ceo@tnacademy.kr',    role: 'ceo',     title: '대표',       hiredOn: '2019-03-02' },
  { id: 2,  name: '박관리', email: 'admin@tnacademy.kr',  role: 'admin',   title: '관리자',     hiredOn: '2021-01-04' },
  { id: 3,  name: '이수현', email: 'head@tnacademy.kr',   role: 'manager', title: '교수실장',   hiredOn: '2020-06-15' },
  { id: 4,  name: '정은채', email: 'coord@tnacademy.kr',  role: 'manager', title: '코디네이터', hiredOn: '2022-09-01' },
  { id: 5,  name: '한지호', email: 'intake@tnacademy.kr', role: 'manager', title: '상담실장',   hiredOn: '2022-03-14' },
  { id: 6,  name: '김서영', email: 't01@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2023-02-01' },
  { id: 7,  name: '박도윤', email: 't02@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2023-03-06' },
  { id: 8,  name: '윤가은', email: 't03@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2023-08-21' },
  { id: 9,  name: '최윤호', email: 't04@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2024-01-08' },
  { id: 10, name: '장미르', email: 't05@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2024-03-04' },
  { id: 11, name: '오세진', email: 't06@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2024-07-15' },
  { id: 12, name: '신하늘', email: 't07@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2024-09-02' },
  { id: 13, name: '문태경', email: 't08@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2025-01-06' },
  { id: 14, name: '배시연', email: 't09@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2025-03-03' },
  { id: 15, name: '노경민', email: 't10@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2025-06-02' },
  { id: 16, name: '홍지수', email: 't11@tnacademy.kr',    role: 'teacher', title: null,        hiredOn: '2025-09-01' },
] as const;

/** 시급 — 강사만. 대표만 본다 (D-R39 canSeeProfit) */
export const WAGES: Array<{ staffId: number; rate: number; fromDate: string }> = [
  { staffId: 6, rate: 42000, fromDate: '2025-03-01' },
  { staffId: 7, rate: 40000, fromDate: '2025-03-01' },
  { staffId: 8, rate: 38000, fromDate: '2025-03-01' },
  { staffId: 9, rate: 38000, fromDate: '2025-03-01' },
  { staffId: 10, rate: 36000, fromDate: '2025-03-01' },
  { staffId: 11, rate: 36000, fromDate: '2025-06-01' },
  { staffId: 12, rate: 35000, fromDate: '2025-06-01' },
  { staffId: 13, rate: 35000, fromDate: '2026-01-01' },
  { staffId: 14, rate: 34000, fromDate: '2026-03-01' },
  { staffId: 15, rate: 34000, fromDate: '2026-06-01' },
  { staffId: 16, rate: 33000, fromDate: '2026-09-01' },
];

/** 프로그램 단가 — 명세서 §54 수업료 계산 */
export const RATES = [
  { kindKey: 'class',      subKey: 'ap-chem',   unitPrice: 80000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'sat-math',  unitPrice: 80000, fromDate: '2026-01-01' },
  { kindKey: 'class',      subKey: 'writing',   unitPrice: 60000, fromDate: '2026-01-01' },
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
