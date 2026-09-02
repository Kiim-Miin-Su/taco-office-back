/**
 * rules.ts 회귀 테스트 — prototype/test/rules.test.js 를 옮긴 것.
 *
 * 2026-08-27 대표 결정(docs/decisions/DECISIONS-2026-08-27.md)을 한 줄씩 검증한다.
 *   D-R7   정산 조건 = 「썼는가」 하나. 승인 여부를 보지 않는다
 *   D-R32  지각 차감 = 수업 종료 후 1시간↑ 5,000 · 4시간↑ 10,000, 그 위로 안 늘어난다
 *   D-R35  출결 = 강사는 당일 최초 체크 1회. 지난 회차는 매니저 이상만
 *   D-15   원천징수 = 소득세 3% + 지방소득세(소득세의 10%), 각각 절사
 *   D8     시급은 수업일 기준. 변경은 그 이후 수업부터
 *
 * 원본과 달라진 점 하나 — 프로토타입은 TODAY·NOW_MIN 전역을 읽었지만
 * 여기서는 **인자로 받는다.** 서버는 요청 시각이 매번 다르므로 전역이면 테스트가 거짓말을 한다.
 */
import * as R from '../src/lib/rules';
import type { SessionLike, AttendanceCtx } from '../src/lib/rules';

const ok = (cond: unknown, name: string, extra?: unknown): void => {
  if (!cond && extra !== undefined) console.error(`  ↳ ${name}:`, JSON.stringify(extra));
  expect(`${name} :: ${cond ? 'ok' : 'FAIL'}`).toBe(`${name} :: ok`);
};

const TODAY = '2026-08-21';
const NOW_MIN = 15 * 60 + 35; // 15:35

/** 회차 하나 — 09:00~10:00 (60분) */
const S = (over: Partial<SessionLike & AttendanceCtx> = {}): SessionLike & AttendanceCtx => ({
  date: TODAY,
  startMin: 9 * 60,
  durationMin: 60,
  canceled: false,
  report: 'none',
  submittedAt: null,
  att: null,
  statusChanged: null,
  ...over,
});

describe('1. 정산 조건 — 「썼는가」 하나 (D-R7 · 대표 결정 1번)', () => {
  it('승인 여부를 보지 않는다', () => {
    const c = R.countsForSettlement;
    ok(c(S({ report: 'approved' })) === true, '승인된 리포트는 들어간다');
    ok(c(S({ report: 'submitted' })) === true, '승인 대기도 들어간다 — 승인을 기다리다 깎이지 않는다');
    ok(c(S({ report: 'rejected' })) === true, '반려도 들어간다 — 반려로 급여가 깎이지 않는다');
    ok(c(S({ report: 'none' })) === false, '미작성은 안 들어간다');
    ok(c(S({ report: 'draft' })) === false, '임시저장은 아직 쓴 것이 아니다');
    ok(c(S({ report: 'approved', canceled: true })) === false, '취소된 수업은 리포트가 있어도 안 들어간다');
    ok(c(S({ report: undefined })) === false, '리포트 상태가 없으면 안 들어간다');
  });

  it('판정이 한 줄에만 산다', () => {
    ok(R.REPORT_WRITTEN.length === 3, '「썼다」로 인정하는 상태는 셋');
    ok(
      R.REPORT_WRITTEN.includes('submitted') &&
        R.REPORT_WRITTEN.includes('approved') &&
        R.REPORT_WRITTEN.includes('rejected'),
      '제출 · 승인 · 반려',
    );
    ok(!R.REPORT_WRITTEN.includes('draft'), '임시저장은 빠져 있다');
  });
});

describe('2. 지각 차감 — 수업 종료 시각 기준 (D-R32 · 대표 결정 5번)', () => {
  it('구간표가 시각 기준이다', () => {
    ok(R.LATE_REPORT_TIERS.length === 3, '구간은 셋이다 (0 · 1시간 · 4시간)', R.LATE_REPORT_TIERS.length);
    ok(
      R.LATE_REPORT_TIERS.every((t) => 'fromMinutes' in t),
      '기준이 분(fromMinutes)이다 — 더는 날짜가 아니다',
    );
  });

  it('경계값이 정확하다', () => {
    const tier = (m: number) => R.tierFor(m).amount;
    ok(tier(0) === 0, '끝나자마자 내면 0원');
    ok(tier(59) === 0, '59분은 아직 0원');
    ok(tier(60) === 5000, '정확히 1시간이면 5,000원 — "1시간 이상"');
    ok(tier(239) === 5000, '3시간 59분은 5,000원');
    ok(tier(240) === 10000, '정확히 4시간이면 10,000원');
    ok(tier(1440) === 10000, '하루가 지나도 10,000원 — 그 위로 안 늘어난다');
    ok(tier(99999) === 10000, '한 달이 지나도 10,000원');
  });
});

describe('2-b. latePenalty — 실제 회차의 확정 차감액', () => {
  it('최초 제출 시각으로 잰다', () => {
    const p = R.latePenalty;
    /* 09:00~10:00 수업. 종료는 10:00 */
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 10:00` })) === 0, '종료 즉시 제출 — 0원');
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 10:59` })) === 0, '59분 뒤 제출 — 0원');
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 11:00` })) === 5000, '1시간 뒤 제출 — 5,000원');
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 14:00` })) === 10000, '4시간 뒤 제출 — 10,000원');
    ok(p(S({ report: 'submitted', submittedAt: '2026-08-24 09:00' })) === 10000, '사흘 뒤 제출도 10,000원에서 멈춘다');
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 09:30` })) === 0, '수업 중에 미리 써 두면 0원 (음수 시간)');
    ok(p(S({ report: 'approved', submittedAt: null })) === 0, '제출 시각이 없으면 0원');
    ok(p(S({ report: 'submitted', submittedAt: `${TODAY} 14:00`, canceled: true })) === 0, '취소된 수업은 차감하지 않는다');
  });

  it('minutesSinceEnd 가 날짜를 넘긴다', () => {
    ok(R.minutesSinceEnd(S(), TODAY, 10 * 60) === 0, '종료 정각이면 0분');
    ok(R.minutesSinceEnd(S(), TODAY, 12 * 60) === 120, '두 시간 뒤면 120분');
    ok(R.minutesSinceEnd(S(), '2026-08-22', 10 * 60) === 1440, '하루 뒤면 1440분');
    ok(R.minutesSinceEnd(S(), TODAY, 9 * 60) === -60, '수업 중이면 음수');
  });
});

describe('2-c. penaltyNow — 지금 제출하면 얼마인가', () => {
  it('지난 시간을 말해 준다', () => {
    /* NOW_MIN = 15:35. 09:00~10:00 수업이면 종료 후 335분 = 5시간 35분 */
    const now = R.penaltyNow(S(), TODAY, NOW_MIN);
    ok(now.amount === 10000, '5시간 35분 지났으니 10,000원', now.amount);
    ok(now.next === null, '더 오를 구간이 없다', now.next);
    ok(now.over === false, '"정산 제외"는 더 이상 없다 — 늦어도 쓰면 들어간다 (D-R7)');
    ok(/5시간 35분/.test(now.head), '얼마나 지났는지를 말해 준다', now.head);
  });

  it('다음 구간까지 남은 시간을 알려 준다', () => {
    /* 14:00~15:00 수업 → 종료 15:00, 지금 15:35 = 35분 */
    const soon = R.penaltyNow(S({ startMin: 14 * 60 }), TODAY, NOW_MIN);
    ok(soon.amount === 0, '35분 지났으면 아직 0원', soon.amount);
    ok(soon.next === 5000 && soon.nextIn === 25, '25분 뒤에 5,000원이 붙는다고 알려 준다', {
      next: soon.next,
      nextIn: soon.nextIn,
    });
  });

  it('아직 안 끝난 수업은 다르게 말한다', () => {
    const future = R.penaltyNow(S({ startMin: 16 * 60 }), TODAY, NOW_MIN);
    ok(future.amount === 0, '아직 안 끝난 수업은 0원');
    ok(/수업이 끝나면/.test(future.head), '끝나면 쓰라고 안내한다', future.head);
    ok(future.next === 5000, '1시간 뒤 구간을 미리 알려 준다');
  });

  it('sinceText 가 사람 말로 읽어 준다', () => {
    ok(R.sinceText(30) === '30분', '한 시간 미만은 분으로');
    ok(R.sinceText(60) === '1시간', '정각은 시간만');
    ok(R.sinceText(135) === '2시간 15분', '나머지가 있으면 둘 다');
  });
});

describe('2-d. PENALTY_RULE — 화면에 뿌리는 표는 작은 것부터', () => {
  it('읽는 순서로 뒤집혀 있다', () => {
    const T = R.PENALTY_RULE;
    ok(T.length === 3, '세 줄');
    ok(
      T[0]!.amount === 0 && T[1]!.amount === 5000 && T[2]!.amount === 10000,
      '0 → 5,000 → 10,000 순서로 읽힌다',
      T.map((x) => x.amount),
    );
    ok(
      T.every((x) => x.amount !== null && x.amount !== undefined),
      '"정산 제외" 칸이 사라졌다',
    );
    ok(R.LATE_REPORT_TIERS[0]!.amount === 10000, '판정용 배열은 큰 것부터 그대로다');
  });
});

describe('2-e. 리포트 입력·저장 계약 (D-R15 · D-R40)', () => {
  const allowed = {
    actorId: 7,
    teacherId: 7,
    canCrudAll: false,
    reportable: true,
    canceled: false,
    ended: true,
    state: 'none' as const,
  };

  it('강사 입력은 content · progress · homework 세 키뿐이다', () => {
    expect(R.REPORT_FIELDS.map((field) => field.key)).toEqual(['content', 'progress', 'homework']);
    expect(new Set(R.REPORT_FIELDS.map((field) => field.key)).size).toBe(3);
  });

  it('임시저장은 빈 칸을 허용하고 제출은 모두 채워야 한다', () => {
    const body = { content: '수업 내용', progress: '  ', homework: '과제' };
    expect(R.reportBodyIssue(body, 'draft')).toBeNull();
    expect(R.reportBodyIssue(body, 'submit')).toBe('progress');
    expect(R.reportBodyIssue({ ...body, progress: '수학 II 42p' }, 'submit')).toBeNull();
  });

  it('담당 강사와 전체 관리 권한만 끝난 회차를 저장한다', () => {
    expect(R.reportWriteIssue(allowed)).toBeNull();
    expect(R.reportWriteIssue({ ...allowed, actorId: 8 })).toBe('REPORT_FORBIDDEN');
    expect(R.reportWriteIssue({ ...allowed, actorId: 8, canCrudAll: true })).toBeNull();
    expect(R.reportWriteIssue({ ...allowed, ended: false })).toBe('REPORT_NOT_ENDED');
    expect(R.reportWriteIssue({ ...allowed, canceled: true })).toBe('REPORT_CANCELED');
    expect(R.reportWriteIssue({ ...allowed, reportable: false })).toBe('REPORT_NOT_ALLOWED');
  });

  it('제출 대기·승인 상태는 수정을 잠그고 반려 상태는 재작성할 수 있다', () => {
    expect(R.reportWriteIssue({ ...allowed, state: 'wait' })).toBe('REPORT_LOCKED');
    expect(R.reportWriteIssue({ ...allowed, state: 'ok' })).toBe('REPORT_LOCKED');
    expect(R.reportWriteIssue({ ...allowed, state: 'rej' })).toBeNull();
  });
});

describe('3. 출결 — 강사는 당일 최초 체크 1회뿐 (D-R35 · 대표 결정 6번)', () => {
  const teacher = { isTeacher: true, today: TODAY, nowMin: NOW_MIN };
  const manager = { isTeacher: false, today: TODAY, nowMin: NOW_MIN };
  const YESTERDAY = '2026-08-20';

  it('강사에게 열리는 것은 오늘 한 번뿐이다', () => {
    ok(R.canEditAttendance(S(), teacher) === 'first', '오늘 끝난 내 수업 — 최초 체크 1회 가능');
    ok(
      R.canEditAttendance(S({ att: { by: '김범준', at: '', result: 'completed' } }), teacher) === 'readonly',
      '이미 찍힌 뒤에는 강사에게 읽기 전용',
    );
    ok(
      R.canEditAttendance(S({ date: YESTERDAY }), teacher) === 'readonly',
      '⭐ 어제 수업은 강사가 최초 체크조차 못 한다 — 매니저 몫이다',
    );
    ok(R.canEditAttendance(S({ startMin: 16 * 60 }), teacher) === 'readonly', '아직 안 끝난 수업에는 출결이 없다');
    ok(R.canEditAttendance(S({ canceled: true }), teacher) === 'readonly', '관리자가 취소한 수업은 손대지 않는다');
    ok(
      R.canEditAttendance(S({ statusChanged: { by: '이매니저', at: '' } }), teacher) === 'readonly',
      '매니저가 먼저 찍었으면 강사는 못 만진다',
    );
  });

  it('매니저 이상은 언제든 정정한다', () => {
    ok(R.canEditAttendance(S(), manager) === 'manage', '매니저는 오늘 회차를 언제든 정정한다');
    ok(R.canEditAttendance(S({ date: YESTERDAY }), manager) === 'manage', '매니저는 어제 회차도 정정한다');
    ok(
      R.canEditAttendance(S({ att: { by: '김범준', at: '', result: 'completed' } }), manager) === 'manage',
      '매니저는 이미 찍힌 것도 정정한다',
    );
    ok(R.canEditAttendance(S({ canceled: true }), manager) === 'manage', '취소분도 매니저는 다룬다');
  });
});

describe('3-b. firstCheck — 거절 사유가 상황마다 다르다', () => {
  const teacher = { isTeacher: true, today: TODAY, nowMin: NOW_MIN };

  it('"안 됩니다"로 뭉치지 않는다', () => {
    const r1 = R.firstCheck(S({ date: '2026-08-20' }), 'completed', teacher);
    ok(r1.ok === false && /매니저/.test(r1.msg), '지난 수업은 매니저가 처리한다고 말해 준다', r1.msg);

    const r2 = R.firstCheck(S({ startMin: 16 * 60 }), 'completed', teacher);
    ok(r2.ok === false && /끝난 뒤/.test(r2.msg), '아직 안 끝났다고 말해 준다', r2.msg);

    const r3 = R.firstCheck(S({ att: { by: '나', at: '', result: 'completed' } }), 'completed', teacher);
    ok(r3.ok === false && /이미/.test(r3.msg), '이미 찍혔다고 말해 준다', r3.msg);

    const r4 = R.firstCheck(S(), 'completed', { isTeacher: false, today: TODAY, nowMin: NOW_MIN });
    ok(r4.ok === false && /매니저 정정/.test(r4.msg), '매니저는 정정 경로로 보낸다', r4.msg);
  });

  it('오늘 회차는 확정된다', () => {
    const okRes = R.firstCheck(S(), 'completed', teacher);
    ok(okRes.ok === true, '오늘 회차는 확정된다');
    ok(/완료/.test(okRes.msg), '완료로 확정했다고 말해 준다');
    const cancelRes = R.firstCheck(S(), 'canceled', teacher);
    ok(cancelRes.ok === true && /취소/.test(cancelRes.msg), '취소로도 확정된다');
  });
});

describe('4. 기한 — 독촉이지 정산 제외가 아니다 (D-R7)', () => {
  it('기한이 지나도 쓰면 들어간다', () => {
    const old = S({ date: '2026-08-01', report: 'submitted', submittedAt: '2026-08-15 10:00' });
    ok(R.isOverdue(old, TODAY, NOW_MIN) === false, '이미 쓴 회차는 독촉 대상이 아니다');
    ok(R.isPastDeadline(old, TODAY, NOW_MIN) === true, '기한 자체는 지났다 — 두 판정이 다르다');
    ok(R.countsForSettlement(old) === true, '⭐ 기한을 한참 넘겨 썼어도 정산에 들어간다');
    ok(R.latePenalty(old) === 10000, '대신 지각 차감 10,000원이 붙는다');
  });

  it('안 쓴 회차만 독촉 목록에 오른다', () => {
    const notWritten = S({ date: '2026-08-01', report: 'none' });
    ok(R.isOverdue(notWritten, TODAY, NOW_MIN) === true, '기한이 지나도록 안 썼으면 독촉');
    ok(R.daysLeft(notWritten, TODAY) < 0, '남은 날이 음수');
    const fresh = S({ date: '2026-08-20', report: 'none' });
    ok(R.isOverdue(fresh, TODAY, NOW_MIN) === false, '어제 수업은 아직 기한 안');
    ok(R.daysLeft(fresh, TODAY) === 9, '9일 남았다', R.daysLeft(fresh, TODAY));
  });
});

describe('5. 원천징수 — 두 항목을 따로 절사한다 (D-15)', () => {
  it('3.3% 를 한 번에 곱하지 않는다', () => {
    const w = R.withholding(1_000_000);
    ok(w.income === 30000, '소득세 3%');
    ok(w.local === 3000, '지방소득세 = 소득세의 10%');
    ok(w.total === 33000, '합계');

    // 절사가 갈리는 값 — 한 번에 3.3% 를 곱하면 1원이 어긋난다
    const odd = R.withholding(333_333);
    ok(odd.income === 9999, '소득세는 원 단위 버림');
    ok(odd.local === 999, '지방소득세도 따로 버림');
    ok(odd.total === 10998, '따로 버린 합 (한 번에 곱하면 10,999)', odd);
    ok(Math.floor(333_333 * 0.033) !== odd.total, '⭐ 한 번에 곱한 값과 실제로 다르다');
  });
});

describe('6. 시급 이력 — 수업일 기준, 소급 없음 (D8)', () => {
  const history = [
    { from: '2026-01-01', rate: 40000 },
    { from: '2026-07-01', rate: 45000 },
  ];

  it('그 수업일에 유효한 단가를 쓴다', () => {
    ok(R.rateAt(history, '2026-06-30') === 40000, '변경 전 수업은 옛 단가');
    ok(R.rateAt(history, '2026-07-01') === 45000, '변경 당일부터 새 단가');
    ok(R.rateAt(history, '2026-08-21') === 45000, '이후는 새 단가');
    ok(R.rateAt(history, '2025-12-31') === 0, '이력 이전은 0 — 조용히 추측하지 않는다');
  });

  it('이력 순서가 뒤죽박죽이어도 같다', () => {
    const shuffled = [...history].reverse();
    ok(R.rateAt(shuffled, '2026-06-30') === 40000, '정렬해서 판정한다');
    ok(R.rateAt(shuffled, '2026-08-21') === 45000, '최신이 이긴다');
  });
});

describe('7. 시각은 분 정수다 (AGENT.md 원칙 17)', () => {
  it('문자열 변환은 표시 직전에만', () => {
    ok(R.toMin('09:30') === 570, "'09:30' → 570");
    ok(R.toMin('00:00') === 0, "'00:00' → 0");
    ok(R.toMin('23:59') === 1439, "'23:59' → 1439");
    ok(R.toMin('엉뚱한 값') === 0, '형식이 아니면 0 — 조용히 NaN 을 흘리지 않는다');
    ok(R.fromMin(570) === '09:30', "570 → '09:30'");
    ok(R.fromMin(0) === '00:00', "0 → '00:00'");
    ok(R.fromMin(1439) === '23:59', "1439 → '23:59'");
  });
});
