import { normalizeChangeRequest } from '../src/lib/change-request';

const target = { serId: 12, onDate: '2026-09-03', reason: '  수업 사정  ' };

describe('변경 요청 종류별 계약', () => {
  it('시간 이동은 기존 수업 시간 계약을 쓰고 저장 모양을 정규화한다', () => {
    const result = normalizeChangeRequest({
      ...target, reqType: 'time_move', startMin: 600, endMin: 660,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        serId: 12, onDate: '2026-09-03', reason: '수업 사정', applyAll: false,
        reqType: 'time_move', payload: { startMin: 600, endMin: 660 },
      },
    });

    const bad = normalizeChangeRequest({
      ...target, reqType: 'time_move', startMin: 600, endMin: 605,
    });
    expect(bad).toMatchObject({ ok: false, issue: { code: 'BAD_RANGE' } });
  });

  it('종류와 무관한 필드를 섞어 보내면 조용히 버리지 않고 거절한다', () => {
    const result = normalizeChangeRequest({
      ...target, reqType: 'teacher', teacherId: 3, roomId: 2,
    });
    expect(result).toMatchObject({ ok: false, issue: { code: 'BAD_CHANGE_FIELDS' } });
  });

  it('강의실과 Zoom은 정확히 하나만 받는다', () => {
    expect(normalizeChangeRequest({ ...target, reqType: 'room', roomId: 2 }))
      .toMatchObject({ ok: true, value: { payload: { roomId: 2 } } });
    expect(normalizeChangeRequest({ ...target, reqType: 'room', zaccId: 3 }))
      .toMatchObject({ ok: true, value: { payload: { zaccId: 3 } } });
    expect(normalizeChangeRequest({ ...target, reqType: 'room', roomId: 2, zaccId: 3 }))
      .toMatchObject({ ok: false, issue: { code: 'ROOM_REQUIRED' } });
    expect(normalizeChangeRequest({ ...target, reqType: 'room', roomId: 2, zaccId: 0 }))
      .toMatchObject({ ok: false, issue: { code: 'ROOM_REQUIRED' } });
  });

  it('취소도 대상 회차가 필수이고 변경 필드는 받을 수 없다', () => {
    expect(normalizeChangeRequest({ reqType: 'cancel', reason: '병가' }))
      .toMatchObject({ ok: false, issue: { code: 'TARGET_REQUIRED' } });
    expect(normalizeChangeRequest({ ...target, reqType: 'cancel', startMin: 600 }))
      .toMatchObject({ ok: false, issue: { code: 'BAD_CHANGE_FIELDS' } });
    expect(normalizeChangeRequest({ ...target, reqType: 'cancel', reason: '가'.repeat(501) }))
      .toMatchObject({ ok: false, issue: { code: 'REASON_TOO_LONG' } });
  });

  it('달력상 불가능한 날짜는 DB에 도달하기 전에 거절하고 저장 사유 길이는 trim 뒤 잰다', () => {
    expect(normalizeChangeRequest({ ...target, reqType: 'cancel', onDate: '2026-02-30' }))
      .toMatchObject({ ok: false, issue: { code: 'TARGET_REQUIRED' } });
    expect(normalizeChangeRequest({ ...target, reqType: 'cancel', onDate: '0000-01-01' }))
      .toMatchObject({ ok: false, issue: { code: 'TARGET_REQUIRED' } });
    expect(normalizeChangeRequest({
      ...target, reqType: 'cancel', reason: ` ${'가'.repeat(500)} `,
    })).toMatchObject({ ok: true, value: { reason: '가'.repeat(500) } });
  });
});
