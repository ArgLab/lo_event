import globals from 'globals';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      }
    },
    rules: {
      // TypeScript handles these better than eslint
      'no-unused-vars': 'off',
      'no-undef': 'off',
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      }
    }
  }
];
