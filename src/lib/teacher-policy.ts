/** @file-guide
 * 목적: teacher-policy.ts — SUGGESTION_MONTHLY_LIMIT, UNAV_DEADLINE_DAYS, TEACHER_POLICY_SCREENS, teacherPolicies (lib)
 * 책임/재사용: 강사 화면 최상단 정책 띠의 낱말 한 곳. 숫자는 판정이 쓰는 상수를 그대로 읽는다 — 판정과 안내가 갈리지 않게.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 강사 정책 띠 — 대표 결정 2026-09-25 「강사 정책은 강사 화면 7개 전부의 최상단」.
 *
 * 낱말은 강사 원문 덱(강사_백오피스_실제_화면_중심_구조.pptx §16 불가 시간 · §28 수업 안내 · §31~32
 * 수업 히스토리 · §34 건의 사항 · §36 줌 계정 운영 주의)에서 가져오되, **그 뒤에 확정된 결정이 이긴다**:
 *   - 불가 시간 마감은 덱의 「회차 시작 1주 전」이 아니라 N-20 채택 「날짜별 7일 전」이다.
 *   - 정산은 덱의 「승인된 리포트만」이 아니라 D-R7 「리포트를 썼는가」다.
 *   - 지각 차감은 덱의 「분 단위」가 아니라 D-R32 두 구간이다(리포트 화면의 차감 띠가 따로 말한다).
 * 홈·캘린더·리포트 세 화면은 돈이 걸린 지각 차감 띠(`lateReportTiers`)를 최상단에 두므로 여기 없다.
 *
 * 숫자는 판정 상수를 읽어 만든다 — 한도가 바뀌면 안내도 같이 바뀐다 (D-R18 · D-R22).
 */
import { LATE_REPORT_TIERS } from './rules';

/** 건의 월 한도 (강사 원문 §34 「월 3회」 — 서버가 센다, SUGGESTION_QUOTA_EXCEEDED) */
export const SUGGESTION_MONTHLY_LIMIT = 3;
/** 불가 시간 (N-20 채택 2026-09-12 §4-17) — 등록 대상 **날짜별 7일 전 마감** */
export const UNAV_DEADLINE_DAYS = 7;

export const TEACHER_POLICY_SCREENS = ['unavailable', 'guides', 'history', 'suggestions'] as const;
export type TeacherPolicyScreen = (typeof TEACHER_POLICY_SCREENS)[number];

export interface TeacherPolicy {
  screen: TeacherPolicyScreen;
  title: string;
  lines: string[];
}

/** 지각 차감 두 구간을 한 문장으로 — 금액은 판정 표(LATE_REPORT_TIERS)에서 */
function lateCutsSentence(): string {
  return [...LATE_REPORT_TIERS]
    .filter((tier) => tier.amount > 0)
    .reverse()
    .map((tier) => `${tier.when} ${tier.cut}`)
    .join(' · ');
}

export function teacherPolicies(): TeacherPolicy[] {
  return [
    {
      screen: 'unavailable',
      title: '불가 시간 등록 규칙',
      lines: [
        '2주 단위 회차마다 등록합니다 — 상시 등록이 아닙니다.',
        `날짜마다 ${UNAV_DEADLINE_DAYS}일 전에 마감됩니다 — 마감된 날짜는 관리자에게 문의해 주세요.`,
        '사유는 꼭 적어 주세요 — 관리자가 조정할 수 있는지 판단합니다.',
      ],
    },
    {
      screen: 'guides',
      title: '수업 전에 확인할 것',
      lines: [
        '학생 카드의 진단 결과 · 주의사항 · 최근 리포트를 보고 들어갑니다.',
        '학생에게는 참가 링크만 보냅니다 — 선생님용 로그인 정보와 섞지 않습니다.',
        '새 기기로 줌에 로그인하면 계정 메일로 인증 코드가 갑니다 — 수업 10분 전에 로그인해 두세요.',
      ],
    },
    {
      screen: 'history',
      title: '정산 규칙',
      lines: [
        '리포트를 쓴 수업만 정산에 들어갑니다 — 승인 여부는 보지 않습니다.',
        `리포트 지각 차감은 최초 제출 시각으로 확정됩니다 — ${lateCutsSentence()}.`,
        '이 정산 내역은 본인만 볼 수 있습니다.',
      ],
    },
    {
      screen: 'suggestions',
      title: '건의 규칙',
      lines: [
        `한 달에 ${SUGGESTION_MONTHLY_LIMIT}회까지 남길 수 있습니다 — 꼭 필요한 것만 올라오게 하려는 제한입니다.`,
        '관리자가 답하면 답변한 사람과 시각이 함께 남습니다.',
      ],
    },
  ];
}
