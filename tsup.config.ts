import { defineConfig } from 'tsup';
export default defineConfig({
    entry: ['nodes/**/*.node.ts', 'credentials/**/*.credentials.ts'],
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    bundle: true,
    splitting: false,
    sourcemap: false,
    minifyWhitespace: true,
    esbuildOptions(options) { options.legalComments = 'eof'; },
    clean: true,
    dts: false,
    external: ['n8n-workflow', '@langchain/core', '@langchain/core/*'],
    noExternal: ['@zihin/agent-client'],
});
