/** @file-guide
 * 목적: jest.config.js (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

/** 규칙 테스트는 프로토타입에서 옮겨 온 것이고, 숫자가 줄어들면 회귀다. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testEnvironment: 'node',
  // 시험 파일마다 import 전에 실제 발송 키(SMTP · SENS)를 비운다 — `.env.local` 의 키가 시험에 들어오지 않게(2026-09-27)
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};
