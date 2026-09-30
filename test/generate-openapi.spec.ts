/** @file-guide
 * 목적: OpenAPI 검사 명령이 암묵적인 환경파일의 DB 에 연결하지 않도록 확인한다.
 * 책임/재사용: 스크립트의 DB 대상 지정 방어만 검증한다. 실제 DB 는 사용하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('OpenAPI 계약 검사 DB 대상', () => {
  it('명시한 DATABASE_URL 이 없으면 AppModule 을 로드하기 전에 실패한다', () => {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', 'scripts/generate-openapi.ts', '--check'],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: '' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL 을 셸에 명시하세요');
    expect(result.stderr).not.toContain('ECONNREFUSED');
    expect(result.stderr).not.toContain('DB 에 못 붙었습니다');
  });
});
