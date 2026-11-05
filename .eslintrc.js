module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'n8n-nodes-base'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    // Regras do nó VERIFICADO do n8n — sem elas a verificacao rejeita na submissao.
    'plugin:n8n-nodes-base/community',
    'plugin:n8n-nodes-base/credentials',
    'plugin:n8n-nodes-base/nodes',
  ],
  env: {
    node: true,
    es2021: true,
  },
  rules: {
    // Legacy rules that contradict the current verification scanner (@n8n/scan-community-package),
    // which requires NodeConnectionTypes.Main instead of the 'main' literal.
    'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
    'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'warn',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'gulpfile.js'],
};
