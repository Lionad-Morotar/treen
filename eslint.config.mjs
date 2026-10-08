import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/coverage/**',
      '**/*.d.ts',
      // refs/ 放第三方参考实现的 submodule，它们的风格由上游自己的 lint 配置管，
      // 本仓的规则套上去只会产出几百条与 Treen 无关的噪声。
      'refs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommended],
  },
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ['**/pages/**/*.vue'],
    rules: {
      // 路由页文件名由文件系统决定（index.vue 等），单字名是约定而非缺陷。
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
)
