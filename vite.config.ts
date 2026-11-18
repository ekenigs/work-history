import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    printWidth: 100,
    sortImports: true,
    sortPackageJson: true,
    ignorePatterns: ['dist/**', 'coverage/**', 'pnpm-lock.yaml'],
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'node', 'vitest'],
    // Every category is on: style warns, the rest fails the check.
    categories: {
      correctness: 'error',
      suspicious: 'error',
      pedantic: 'error',
      perf: 'error',
      restriction: 'error',
      style: 'warn',
    },
    env: { es2024: true, node: true },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ['dist/**', 'coverage/**'],
    // Rules switched off or tuned on purpose; each says why.
    rules: {
      // The JSONL records use null for "no value"; that is the output contract.
      'unicorn/no-null': 'off',
      // A Node CLI: Node modules and sync fs/child_process calls are the point.
      'import/no-nodejs-modules': 'off',
      'node/no-sync': 'off',
      // Contradictory pairs and export layout: named exports, a default only where a tool needs one.
      'import/no-named-export': 'off',
      'import/no-default-export': 'off',
      'import/group-exports': 'off',
      'import/exports-last': 'off',
      'import/prefer-default-export': 'off',
      // Syntax that Node 24 supports natively.
      'oxc/no-optional-chaining': 'off',
      'oxc/no-rest-spread-properties': 'off',
      'oxc/no-async-await': 'off',
      'no-undefined': 'off',
      // Node's and clack's types are mutable, so this cannot hold at the boundary.
      'typescript/prefer-readonly-parameter-types': 'off',
      // Oxfmt sorts imports (fmt.sortImports); a second, different order would fight it.
      'sort-imports': 'off',
      // Style rules that contradict each other or the formatter.
      // `import type` lines stay separate from value imports of the same module.
      'no-duplicate-imports': ['warn', { allowSeparateTypeImports: true }],
      'one-var': ['warn', 'never'],
      'no-ternary': 'off',
      'sort-keys': 'off',
      'capitalized-comments': 'off',
      'func-style': ['warn', 'declaration', { allowArrowFunctions: true }],
      'id-length': ['warn', { min: 2, exceptions: ['_', 'a', 'b', 'T'] }],
      'no-magic-numbers': [
        'warn',
        { ignore: [-1, 0, 1, 2], ignoreArrayIndexes: true, enforceConst: true },
      ],
    },
    overrides: [
      {
        files: ['src/cli.ts'],
        rules: {
          // The bin entry is executed, never `require`d.
          'node/no-top-level-await': 'off',
        },
      },
      {
        files: ['src/errors.ts'],
        rules: {
          // The error hierarchy lives in one file.
          'max-classes-per-file': 'off',
        },
      },
      {
        files: ['src/**/*.test.ts'],
        rules: {
          // Tests read best as long, literal tables of cases.
          'max-lines-per-function': 'off',
          'max-statements': 'off',
          'no-magic-numbers': 'off',
          'typescript/explicit-function-return-type': 'off',
          // Explicit imports from vite-plus/test over injected globals.
          'vitest/no-importing-vitest-globals': 'off',
          // Pure, synchronous tests; the global timeout applies.
          'vitest/require-test-timeout': 'off',
          'vitest/prefer-expect-assertions': 'off',
          // toBe(true) is stricter than toBeTruthy(); keep the strict form.
          'vitest/prefer-to-be-truthy': 'off',
          'vitest/prefer-to-be-falsy': 'off',
          // Suites titled by the function they test, as prefer-describe-function-title asks.
          'vitest/valid-title': ['error', { allowArguments: true }],
        },
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: { include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] },
  },
  pack: {
    entry: ['src/cli.ts', 'src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: true,
    sourcemap: true,
    clean: true,
  },
})
