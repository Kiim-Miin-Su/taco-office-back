/**
 * SQL 조각 — `lib/sql.ts`. DB 없이 **글자 그대로** 굳힌다.
 *
 * 이 파일이 있는 이유: 시각 형식이 서비스마다 흩어져 있을 때
 * 아홉 군데 전부가 `+00` 을 내려보내고 있었는데 어느 테스트도 잡지 못했다.
 */
import { KST, kstAt, minOf, spanOf, START_MIN, END_MIN } from '../src/lib/sql';

describe('lib/sql', () => {
  it('시간대는 한 곳에서만 정한다 (D-R12)', () => {
    expect(KST).toBe('Asia/Seoul');
    [minOf('x'), kstAt('x'), spanOf('$1', '$2', '$3')].forEach((f) =>
      expect(f).toContain("'Asia/Seoul'"));
  });

  it('내려보내는 시각에는 KST 오프셋이 글자로 붙는다', () => {
    const f = kstAt('created_at');
    expect(f).toContain("AT TIME ZONE 'Asia/Seoul'");
    expect(f).toContain("|| '+09:00'");
    // 서버 세션 시간대를 그대로 쓰는 'OF' 로 돌아가면 안 된다
    expect(f).not.toContain('OF');
  });

  it('분은 시·분을 KST 로 뽑아 더한다', () => {
    expect(START_MIN).toBe(minOf('lower(o.span)'));
    expect(END_MIN).toBe(minOf('upper(o.span)'));
    expect(minOf('x')).toContain('* 60');
  });

  it('겹침은 tstzrange 로 만든다 — DB 의 EXCLUDE 와 같은 연산자를 쓰려고', () => {
    const f = spanOf('$2', '$3', '$4');
    expect(f).toContain('tstzrange(');
    expect(f).toContain("'[)'");
    expect(f).toContain('make_interval(mins => $3)');
  });
});
