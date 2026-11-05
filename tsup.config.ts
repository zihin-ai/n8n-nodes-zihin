import { defineConfig } from 'tsup';

/**
 * Build dos nós n8n. Cada nó/credencial vira um arquivo CJS em dist/, preservando a estrutura
 * de pastas (n8n descobre os nós pelos paths em package.json "n8n").
 *
 * - `@zihin/agent-client` (devDep) é EMBUTIDO no bundle → o pacote publicado fica com ZERO
 *   dependência de runtime (exigência de nó verificado do n8n).
 * - `n8n-workflow` e `@langchain/core` são EXTERNOS (providos pelo host n8n em runtime).
 */
export default defineConfig({
	entry: ['nodes/**/*.node.ts', 'credentials/**/*.credentials.ts'],
	outDir: 'dist',
	format: ['cjs'],
	platform: 'node',
	target: 'node20',
	bundle: true,
	splitting: false,
	// Sem source maps no pacote publicado (evita bloat e exposição da fonte bundlada do núcleo).
	sourcemap: false,
	clean: true,
	dts: false,
	external: ['n8n-workflow', '@langchain/core', '@langchain/core/*'],
	noExternal: ['@zihin/agent-client'],
});
