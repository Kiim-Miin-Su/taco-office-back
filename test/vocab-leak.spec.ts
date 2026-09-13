/** @file-guide
 * 목적: vocab-leak.spec.ts (test)
 * 책임/재사용: 기존 대상 함수를 import하여 정상/거절/경계 회귀를 검증한다. 테스트 안에 제품 규칙을 복제하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/**
 * 화면에 **코드값과 내부 이름이 새는 자리** — C67.
 *
 * 컷 대조에서 나온 것들이다. 하나같이 「낱말은 서버가 만든다」(D-R18)를 지키면 안 날 일이고,
 * 하나같이 **비어 있거나 드문 갈래에서만** 드러나서 눈으로는 안 보였다.
 */
import { PLAN_STAGES, PLAN_STAGE_LABEL } from '../src/lib/plan-words';
import { REQ_TYPE_LABEL } from '../src/lib/approval';
import { chreqAsked } from '../src/lib/change-request';

describe('낱말이 새지 않는다 (C67)', () => {
  it('기획 단계 다섯이 **빠짐없이** 이름을 갖는다 — 빈 칸도 이름을 그린다', () => {
    const missing = PLAN_STAGES.filter((k) => !PLAN_STAGE_LABEL[k]);
    expect(missing).toEqual([]);
    // 화면은 줄에서 이름을 빌려 오고 있었다. 줄이 없는 칸은 빌려 올 데가 없어 `done` 을 찍었다
    expect(PLAN_STAGE_LABEL.done).toBe('완료');
  });

  it('한 요청이 **두 이름으로 불리지 않는다** — 무엇 칸과 대상 칸이 같은 말을 한다', () => {
    // 무엇 칸은 REQ_TYPE_LABEL, 대상 칸은 서버가 지은 문장이다
    expect(chreqAsked('cancel', {}, {})).toBe('휴강');
    expect(REQ_TYPE_LABEL.cancel).toBe('휴강');
  });

  it('원문 §19 의 갈래 넷이 컷의 낱말이다', () => {
    expect(REQ_TYPE_LABEL.time_move).toBe('시간 이동');
    expect(REQ_TYPE_LABEL.teacher).toBe('강사 변경');
    expect(REQ_TYPE_LABEL.room).toBe('강의실 변경');
    expect(REQ_TYPE_LABEL.cancel).toBe('휴강');
  });
});
