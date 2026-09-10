/** @file-guide
 * 목적: eslint.config.mjs (config)
 * 책임/재사용: 기존 런타임/빌드/검사 설정을 유지한다. 의존성·배포·비밀값 변경은 별도 근거와 검증 없이는 추가하지 않는다.
 * 검증/작업 지침: docs/contracts/FILE-GUIDE.md · docs/AGENT.md · docs/CLAUDE.md
 */

// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { sourceType: 'module' } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // AGENT.md 원칙 21 — 권한 판정은 canAdminPage/canCrudAll/canSeeProfit 세 줄에서만 한다.
      // 컨트롤러·서비스가 role 을 직접 비교하면 권한을 한 칸 열어 줄 때 고칠 곳이 흩어진다.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "BinaryExpression[operator=/^[=!]==?$/] > MemberExpression[property.name='role']",
          message:
            "role 을 직접 비교하지 마세요. src/common/perm 의 canAdminPage / canCrudAll / canSeeProfit 을 쓰세요 (D-R39).",
        },
      ],
    },
  },
  {
    // 파생 함수 자신은 role 을 비교해야 한다 — 여기가 유일한 예외다.
    files: ['src/common/perm/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
