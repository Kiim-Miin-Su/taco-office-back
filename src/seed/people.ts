/**
 * 학생 19명 · 등록 · 상담 18건.
 * 명세서 v2 §2 의 실측 규모(상담 18건 · 청구서 6건)를 그대로 맞춘다.
 */
export const STUDENTS = [
  { id: 1,  name: '김민준', grade: '고2', school: '대원외고',   targetExam: 'AP',  startedOn: '2026-03-02', lang: 'ko' },
  { id: 2,  name: '박지우', grade: '고3', school: '한영외고',   targetExam: 'SAT', startedOn: '2025-09-01', lang: 'ko' },
  { id: 3,  name: '최유나', grade: '중3', school: '대치중',     targetExam: 'MAP', startedOn: '2026-06-03', lang: 'ko' },
  { id: 4,  name: '한서준', grade: '고1', school: '휘문고',     targetExam: 'SAT', startedOn: '2026-05-11', lang: 'ko' },
  { id: 5,  name: '오예린', grade: '고3', school: '민사고',     targetExam: 'AP',  startedOn: '2025-07-08', lang: 'ko' },
  { id: 6,  name: '정하람', grade: '고2', school: '외대부고',   targetExam: 'SAT', startedOn: '2026-01-12', lang: 'ko' },
  { id: 7,  name: '윤도현', grade: '중2', school: '숙명중',     targetExam: 'MAP', startedOn: '2026-04-06', lang: 'ko' },
  { id: 8,  name: '서지안', grade: '고3', school: '청심국제고', targetExam: 'AP',  startedOn: '2025-03-04', lang: 'ko' },
  { id: 9,  name: '김하윤', grade: '고1', school: '개포고',     targetExam: 'SAT', startedOn: '2026-02-02', lang: 'ko' },
  { id: 10, name: '이서우', grade: '중1', school: '역삼중',     targetExam: 'MAP', startedOn: '2026-07-01', lang: 'ko' },
  { id: 11, name: '조민서', grade: '고2', school: '경기고',     targetExam: 'SAT', startedOn: '2026-02-16', lang: 'ko' },
  { id: 12, name: '강태윤', grade: '중3', school: '중동중',     targetExam: 'MAP', startedOn: '2026-03-16', lang: 'ko' },
  { id: 13, name: '임하준', grade: '고1', school: '단대부고',   targetExam: 'SAT', startedOn: '2026-04-20', lang: 'ko' },
  { id: 14, name: '송지호', grade: '고2', school: '숭실고',     targetExam: 'AP',  startedOn: '2026-05-04', lang: 'ko' },
  { id: 15, name: '백서현', grade: '중2', school: '언주중',     targetExam: 'MAP', startedOn: '2026-06-15', lang: 'ko' },
  { id: 16, name: 'Emily Park', grade: 'G10', school: 'SIS',   targetExam: 'AP',  startedOn: '2026-01-05', lang: 'en' },
  { id: 17, name: 'Daniel Cho', grade: 'G11', school: 'KIS',   targetExam: 'SAT', startedOn: '2025-11-03', lang: 'en' },
  { id: 18, name: '문채원', grade: '고3', school: '세화여고',   targetExam: 'SAT', startedOn: '2025-08-18', lang: 'ko' },
  { id: 19, name: '권시우', grade: '중3', school: '압구정중',   targetExam: 'MAP', startedOn: '2026-07-13', lang: 'ko' },
] as const;

/** 등록 — 학생이 무엇을 듣는가 */
export const ENROLLMENTS = [
  { studentId: 1,  kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-03-02' },
  { studentId: 1,  kindKey: 'class', subKey: 'writing',  sessions: 8, startedOn: '2026-03-02' },
  { studentId: 2,  kindKey: 'class', subKey: 'sat-math', sessions: 10, startedOn: '2025-09-01' },
  { studentId: 2,  kindKey: 'class', subKey: 'sat-read', sessions: 10, startedOn: '2025-09-01' },
  { studentId: 3,  kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-06-03' },
  { studentId: 4,  kindKey: 'class', subKey: 'vocab',    sessions: 12, startedOn: '2026-05-11' },
  { studentId: 5,  kindKey: 'class', subKey: 'writing',  sessions: 6, startedOn: '2025-07-08' },
  { studentId: 5,  kindKey: 'consulting', subKey: 'admissions', sessions: 13, startedOn: '2026-07-08' },
  { studentId: 6,  kindKey: 'class', subKey: 'writing',  sessions: 6, startedOn: '2026-01-12' },
  { studentId: 7,  kindKey: 'class', subKey: 'map-math', sessions: 5, startedOn: '2026-04-06' },
  { studentId: 7,  kindKey: 'study', subKey: 'study-room', sessions: 20, startedOn: '2026-04-06' },
  { studentId: 8,  kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2025-03-04' },
  { studentId: 9,  kindKey: 'class', subKey: 'vocab',    sessions: 12, startedOn: '2026-02-02' },
  { studentId: 10, kindKey: 'class', subKey: 'map-read', sessions: 6, startedOn: '2026-07-01' },
  { studentId: 11, kindKey: 'class', subKey: 'writing',  sessions: 7, startedOn: '2026-02-16' },
  { studentId: 12, kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-03-16' },
  { studentId: 13, kindKey: 'class', subKey: 'sat-math', sessions: 8, startedOn: '2026-04-20' },
  { studentId: 14, kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-05-04' },
  { studentId: 15, kindKey: 'class', subKey: 'map-read', sessions: 6, startedOn: '2026-06-15' },
  { studentId: 16, kindKey: 'class', subKey: 'ap-chem',  sessions: 8, startedOn: '2026-01-05' },
  { studentId: 17, kindKey: 'class', subKey: 'sat-read', sessions: 10, startedOn: '2025-11-03' },
  { studentId: 18, kindKey: 'class', subKey: 'sat-math', sessions: 10, startedOn: '2025-08-18' },
  { studentId: 19, kindKey: 'class', subKey: 'map-math', sessions: 6, startedOn: '2026-07-13' },
  // 이번 달 등록 — 화면의 「등록」 칸이 늘 0 이면 아무도 그 칸을 안 본다.
  // 기존 학생이 과목을 하나 더 여는 경우로 둔다 (학생 수는 그대로 19명).
  { studentId: 9,  kindKey: 'class', subKey: 'sat-read', sessions: 8, startedOn: '2026-08-11' },
  { studentId: 15, kindKey: 'study', subKey: 'study-room', sessions: 20, startedOn: '2026-08-24' },
];

/**
 * 상담 18건 — 1차 → 2차 대기 → 2차 → 보류 → 등록 / 실패.
 * 중단 지점(§24)이 분류되도록 stopAt 을 실패 건에만 채운다.
 */
export const LEADS = [
  { id: 1,  name: '김민준', studentId: 1,  school: '대원외고',   ownerId: 5, stage: 'enrolled', createdAt: '2026-02-20' },
  { id: 2,  name: '박지우', studentId: 2,  school: '한영외고',   ownerId: 5, stage: 'enrolled', createdAt: '2025-08-14' },
  { id: 3,  name: '최유나', studentId: 3,  school: '대치중',     ownerId: 5, stage: 'enrolled', createdAt: '2026-05-22' },
  { id: 4,  name: '한서준', studentId: 4,  school: '휘문고',     ownerId: 4, stage: 'enrolled', createdAt: '2026-04-29' },
  { id: 5,  name: '권시우', studentId: 19, school: '압구정중',   ownerId: 5, stage: 'enrolled', createdAt: '2026-07-02' },
  { id: 6,  name: '백서현', studentId: 15, school: '언주중',     ownerId: 4, stage: 'enrolled', createdAt: '2026-06-04' },
  { id: 7,  name: '노현우', studentId: null, school: '세종고',   ownerId: 5, stage: 'first',    createdAt: '2026-08-26' },
  { id: 8,  name: '차서윤', studentId: null, school: '반포중',   ownerId: 5, stage: 'first',    createdAt: '2026-08-27' },
  { id: 9,  name: '유하람', studentId: null, school: '경신고',   ownerId: 4, stage: 'wait2nd',  createdAt: '2026-08-24' },
  { id: 10, name: '남지완', studentId: null, school: '서초중',   ownerId: 5, stage: 'wait2nd',  createdAt: '2026-08-22' },
  { id: 11, name: '표은결', studentId: null, school: '양재고',   ownerId: 4, stage: 'second',   createdAt: '2026-08-19' },
  { id: 12, name: '구시온', studentId: null, school: '대명중',   ownerId: 5, stage: 'second',   createdAt: '2026-08-18' },
  { id: 13, name: '진예람', studentId: null, school: '숭의여고', ownerId: 4, stage: 'hold',     createdAt: '2026-08-11' },
  { id: 14, name: '홍은결', studentId: null, school: 'DIS',    ownerId: 5, stage: 'hold',     createdAt: '2026-08-08' },
  { id: 15, name: '고윤슬', studentId: null, school: '개포중',   ownerId: 5, stage: 'failed',   createdAt: '2026-08-05', stopAt: 'before_book', reason: '전화 연결 실패 · 3회 회신 없음' },
  { id: 16, name: '류하은', studentId: null, school: '경기여고', ownerId: 4, stage: 'failed',   createdAt: '2026-08-03', stopAt: 'after_first', reason: '수업료 부담' },
  { id: 17, name: '심우주', studentId: null, school: '삼성중',   ownerId: 5, stage: 'failed',   createdAt: '2026-07-29', stopAt: 'after_second', reason: '시간대 불일치 — 주말반 요청' },
  { id: 18, name: '천보람', studentId: null, school: '휘경고',   ownerId: 4, stage: 'failed',   createdAt: '2026-07-24', stopAt: 'before_first', reason: '타 학원 등록' },
];
