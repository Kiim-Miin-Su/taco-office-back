/**
 * 알림 색 — `lib/noti.ts`.
 *
 * NOTI 표에 색 컬럼이 없어 **링크로 파생**한다. 표에 컬럼이 생기는 날
 * 이 파일이 바뀔 곳을 한 군데로 못 박아 둔다.
 */
import { notiTone, NOTI_TONES } from '../src/lib/noti';

describe('notiTone', () => {
  it('막힌 일은 warn', () => {
    expect(notiTone('/reports/unwritten')).toBe('warn');
    expect(notiTone('/ops/complaints')).toBe('warn');
  });
  it('끝난 소식은 ok', () => {
    expect(notiTone('/accounting/paid')).toBe('ok');
    expect(notiTone('/guides/sent')).toBe('ok');
  });
  it('그 밖에는 alarm — 색이 없어 안 보이는 일은 없다', () => {
    expect(notiTone('/ops/marketing')).toBe('alarm');
    expect(notiTone(null)).toBe('alarm');
    expect(notiTone('')).toBe('alarm');
    expect(notiTone(undefined)).toBe('alarm');
  });
  it('세 가지 밖으로 나가지 않는다', () => {
    ['/x', '/reports/unwritten', '/accounting/paid', null].forEach((l) =>
      expect(NOTI_TONES).toContain(notiTone(l)));
  });
});
