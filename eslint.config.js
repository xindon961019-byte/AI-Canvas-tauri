import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 构建产物不参与检查：src-tauri/target 里有 Rust 依赖自带的 JS，会淹没真实告警
  globalIgnores([
    'dist',
    'dist-ssr',
    'src-tauri/target',
    'src-tauri/gen',
    'src-tauri/vendor',
    // 独立宣传视频项目有自己的依赖和解析器，不属于主应用质量门禁。
    'promo-video',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // 保留 _ 前缀表示「按签名占位、有意不用」的既有约定
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
  {
    // 迁入的上游组件保留原有生命周期；项目接入层仍使用完整检查。
    files: ['src/vendor/generation-effects/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
])
