/**
 * ESLint 扁平配置。
 *
 * 只开「推荐规则 + 类型导入规则 + 禁止 any」，不启用需要类型信息的规则：
 * 全量 type-aware lint 会让 `npm run lint` 从秒级变成分钟级，类型检查由
 * `tsc --noEmit` 承担，ESLint 专注静态坏味道。
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.cache/**',
      '.tmp/**',
      'tests/out/**',
      // 第三方静态资源（Draco 解码器）不参与 lint。
      'public/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      // 未使用变量交给 tsc 的 noUnusedLocals / noUnusedParameters，避免两套重复报错。
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off'
    }
  },
  {
    // 分层守卫：ui 不依赖 water；water 不依赖 ui（通用工具已下沉 shared/）。
    files: ['src/ui/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['../water/*', './water/*'], message: 'ui 层不得依赖 water 层' }]
        }
      ]
    }
  },
  {
    files: ['src/water/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../ui/*', './ui/*'],
              message: 'water 不得依赖 ui；通用工具（dom / format / math）已下沉 shared/'
            }
          ]
        }
      ]
    }
  },
  {
    // shared 是最底层：只能被依赖，不能反向依赖 ui / water。
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../ui/*', '../water/*'],
              message: 'shared/ 不得反向依赖上层模块'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    languageOptions: {
      // verify.mjs 里的 page.evaluate 回调是浏览器上下文代码，
      // 文件本身跑在 Node，所以两套 globals 都要给。
      globals: { ...globals.node, ...globals.browser }
    }
  },
  // 关闭与 Prettier 冲突的格式规则（当前未启用格式类规则，留作兜底）。
  prettierConfig
)
