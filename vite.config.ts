import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    printWidth: 100,
    sortPackageJson: true,
    ignorePatterns: ['dist/**', 'coverage/**', 'pnpm-lock.yaml'],
  },
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise', 'node', 'vitest'],
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
    // Every category is on. The rules below are off or tuned on purpose; each one says why.
    rules: {
      // The JSONL records use null for "no value"; that is the output contract.
      'unicorn/no-null': 'off',
      // A Node CLI: Node modules and sync fs/child_process calls are the point.
      'import/no-nodejs-modules': 'off',
      'node/no-sync': 'off',
      // Contradictory pairs and export layout: named exports everywhere, default only in configs.
      'import/no-named-export': 'off',
      'import/no-default-export': 'off',
      'import/group-exports': 'off',
      'import/exports-last': 'off',
      'import/prefer-default-export': 'off',
      // Modern syntax the target (Node 24) supports.
      'oxc/no-optional-chaining': 'off',
      'oxc/no-rest-spread-properties': 'off',
      'oxc/no-async-await': 'off',
      'no-undefined': 'off',
      // Node's own types are mutable, so this rule cannot be satisfied at the boundary.
      'typescript/prefer-readonly-parameter-types': 'off',
      // Style rules that contradict each other or the formatter.
      'one-var': ['warn', 'never'],
      'no-ternary': 'off',
      'sort-keys': 'off',
      'capitalized-comments': 'off',
      'func-style': ['warn', 'declaration', { allowArrowFunctions: true }],
      'id-length': [
        'warn',
        {
          min: 2,
          exceptions: [
            'a',
            'b',
            'c',
            'd',
            'e',
            'g',
            'i',
            'k',
            'm',
            'n',
            'p',
            'r',
            's',
            'v',
            'w',
            '_',
          ],
        },
      ],
      'no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2, 10, 100],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true,
        },
      ],
    },
    overrides: [
      {
        files: ['src/**/*.test.ts'],
        rules: {
          'max-lines-per-function': 'off',
          'max-statements': 'off',
          'no-magic-numbers': 'off',
          'typescript/explicit-function-return-type': 'off',
        },
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: { include: ['src/**/*.ts'] },
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
