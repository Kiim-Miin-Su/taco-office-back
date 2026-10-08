/** @file-guide
 * 목적: BOC-05E에서 발견한 stale 수업일 409의 actualDate 소실 회귀를 막는다.
 * 책임/재사용: 전용 예외 필터가 허용한 세 필드만 HTTP 응답에 쓰는지 검증한다.
 * 검증/작업 지침: docs/AGENT.md · docs/CLAUDE.md · docs/contracts/FILE-GUIDE.md
 */

import type { ArgumentsHost } from '@nestjs/common';
import { TeacherLessonMovedException, TeacherLessonMovedFilter } from '../src/modules/teacher/teacher-lesson-moved.error';

describe('BOC-05E — teacher lesson moved HTTP error', () => {
  it('409 본문에 최신 actualDate를 보존한다', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const response = { locals: {}, status };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    new TeacherLessonMovedFilter().catch(new TeacherLessonMovedException('2026-10-05'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      code: 'TEACHER_LESSON_MOVED',
      message: '수업일이 변경되었습니다. 최신 일정에서 다시 열어 주세요.',
      actualDate: '2026-10-05',
    });
    expect(response.locals).toEqual({ httpDiagnosticCode: 'TEACHER_LESSON_MOVED' });
  });
});
