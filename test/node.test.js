/*
 * Teste comportamental do nó Zihin Agent (offline): nó → @zihin/agent-client → BE mockado.
 * Requer o build (dist/). Roda: `npm run build && npm test` .
 */
const path = require('path');
const pkgDir = path.join(__dirname, '..');

let pass = 0,
	fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n)));

const { ZihinAgent } = require(path.join(pkgDir, 'dist/nodes/ZihinAgent/ZihinAgent.node.js'));

const enc = new TextEncoder();
function sse(chunks) {
	const stream = new ReadableStream({
		start(c) {
			for (const x of chunks) c.enqueue(enc.encode(x));
			c.close();
		},
	});
	return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Contexto fake de IExecuteFunctions para um único item. */
function ctx(params, { continueOnFail = false, cancelSignal = undefined } = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ apiKey: 'zhn_live_' + 'a'.repeat(24) }),
		getNodeParameter: (name, _i, def) => (name in params ? params[name] : def),
		continueOnFail: () => continueOnFail,
		getNode: () => ({ name: 'Zihin Agent' }),
		getExecutionCancelSignal: () => cancelSignal,
	};
}

async function run() {
	// 1. Caminho feliz — invoca e mapeia a saída
	console.log('\n[execute] caminho feliz');
	globalThis.fetch = async (url) => {
		ok('POST no endpoint de stream do agente', String(url).includes('/api/v2/agents/ag-1/stream'));
		return sse([
			'event: response\ndata: {"content":"Olá!","session_id":"s-1"}\n\n',
			'event: metrics\ndata: {"usage":{"total_tokens":12},"model_config":{"model":"openai.gpt-4o"}}\n\n',
		]);
	};
	const node = new ZihinAgent();
	const out = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }),
	);
	const json = out[0][0].json;
	ok('content mapeado', json.content === 'Olá!');
	ok('sessionId mapeado', json.sessionId === 's-1');
	ok('model mapeado (do metrics)', json.model === 'openai.gpt-4o');
	ok('usage mapeado', json.usage && json.usage.totalTokens === 12);
	ok('raw omitido por padrão', json.raw === undefined);

	// 1b. O timeout do usuário PRECISA chegar ao BE como `options.timeout_ms`.
	// Regressão real pega em review: o nó mandava o valor só na config do cliente, que nunca é
	// transmitida. O usuário setava 25s, o cliente abortava cego aos 25s e o turno seguia rodando
	// — e sendo cobrado — do outro lado. É exatamente a falha que a Fase 1 existe para fechar.
	console.log('\n[execute] timeout do usuário chega ao BE');
	let sentBody = null;
	globalThis.fetch = async (_url, init) => {
		sentBody = JSON.parse(init.body);
		return sse(['event: response\ndata: {"content":"ok"}\n\n']);
	};
	await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: { timeoutMs: 25000 } }),
	);
	ok('options.timeout_ms enviado ao BE', sentBody.options && sentBody.options.timeout_ms === 25000);

	// Sem o usuário pedir, nada é imposto ao BE — ele usa o deadline do próprio canal.
	sentBody = null;
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }));
	ok(
		'sem timeout configurado → nada imposto ao BE',
		!sentBody.options || sentBody.options.timeout_ms === undefined,
	);

	// A procedência do texto precisa chegar ao workflow (Fase 2).
	console.log('\n[execute] contentSource exposto');
	globalThis.fetch = async () => sse(['event: response\ndata: {"content":"final"}\n\n']);
	const src = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }),
	);
	ok('contentSource=response', src[0][0].json.contentSource === 'response');

	globalThis.fetch = async () => sse(['event: token\ndata: {"content":"parcial cru"}\n\n']);
	const partial = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }),
	);
	ok('parcial marcado como tokens', partial[0][0].json.contentSource === 'tokens');

	// Cancelar a execução no n8n precisa DERRUBAR o turno no backend: desde agosto/2026 o abort
	// desce até a chamada ao provider. Sem repassar o signal, cancelar o workflow deixava o agente
	// rodando sozinho, gastando LLM e tools que ninguém leria.
	console.log('\n[execute] cancelamento do host chega ao backend');
	const controller = new AbortController();
	let sawSignal = false;
	globalThis.fetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			sawSignal = init.signal instanceof AbortSignal;
			init.signal.addEventListener('abort', () => {
				const err = new Error('aborted');
				err.name = 'AbortError';
				reject(err);
			});
			setTimeout(() => controller.abort(), 10);
		});
	let cancelErr = null;
	try {
		await node.execute.call(
			ctx(
				{ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} },
				{ cancelSignal: controller.signal },
			),
		);
	} catch (e) {
		cancelErr = e;
	}
	ok('signal repassado ao fetch', sawSignal);
	ok('cancelamento do host aborta a chamada', cancelErr !== null);

	// Campos que o núcleo já entregava e o nó descartava.
	console.log('\n[execute] blocks/iterations/executionTimeMs expostos');
	globalThis.fetch = async () =>
		sse([
			'event: response\ndata: {"content":"ok","blocks":[{"type":"card"}]}\n\n',
			'event: metrics\ndata: {"iterations":3,"execution_time_ms":812}\n\n',
		]);
	const rich = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }),
	);
	ok('blocks expostos', Array.isArray(rich[0][0].json.blocks) && rich[0][0].json.blocks.length === 1);
	ok('iterations expostas', rich[0][0].json.iterations === 3);
	ok('executionTimeMs exposto', rich[0][0].json.executionTimeMs === 812);

	// 2. continueOnFail — erro vira item com {error}, não lança
	console.log('\n[execute] erro com continueOnFail');
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	const out2 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }, { continueOnFail: true }),
	);
	ok('item de erro retornado', typeof out2[0][0].json.error === 'string');
	ok('erro não vaza a key', !out2[0][0].json.error.includes('zhn_live_'));

	// 3. erro sem continueOnFail → lança NodeOperationError
	console.log('\n[execute] erro sem continueOnFail lança');
	let threw = false;
	try {
		await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: {} }));
	} catch (e) {
		threw = true;
		ok('mensagem sanitizada', !String(e.message).includes('zhn_live_'));
	}
	ok('lançou', threw);

	// 4. options chegam ao request (snake_case) + baseUrl custom na URL
	console.log('\n[execute] options → request (snake_case + baseUrl)');
	let captured;
	globalThis.fetch = async (url, init) => {
		captured = { url: String(url), body: JSON.parse(init.body) };
		return sse(['event: response\ndata: {"content":"x"}\n\n']);
	};
	await node.execute.call(
		ctx({
			agentId: 'ag-1',
			message: 'oi',
			sessionId: '',
			options: { temperature: 0.2, maxTokens: 99, baseUrl: 'https://staging.llm.zihin.ai' },
		}),
	);
	ok('URL usa baseUrl custom', captured.url.startsWith('https://staging.llm.zihin.ai/api/v2/agents/ag-1/stream'));
	// sem efeito no /stream (config do agente): o campo fica no formulário, mas não vai ao fio
	ok('temperature NÃO repassado', captured.body.options?.temperature === undefined);
	ok('maxTokens NÃO repassado', captured.body.options?.max_tokens === undefined);

	// 5. múltiplos itens: loop, pairedItem, sessionId por item
	console.log('\n[execute] múltiplos itens (loop + pairedItem + sessionId)');
	const perItem = [
		{ agentId: 'ag-1', message: 'a', sessionId: 's-A', options: {} },
		{ agentId: 'ag-1', message: 'b', sessionId: '', options: {} },
	];
	const bodies = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(init.body));
		return sse([`event: response\ndata: {"content":"r${bodies.length}"}\n\n`]);
	};
	const out5 = await node.execute.call({
		getInputData: () => [{ json: {} }, { json: {} }],
		getCredentials: async () => ({ apiKey: 'zhn_live_' + 'a'.repeat(24) }),
		getNodeParameter: (name, i, def) => (name in perItem[i] ? perItem[i][name] : def),
		continueOnFail: () => false,
		getNode: () => ({}),
	});
	ok('2 itens de saída', out5[0].length === 2);
	ok('pairedItem.item correto', out5[0][1].pairedItem.item === 1);
	ok('item 0 envia session_id', bodies[0].session_id === 's-A');
	ok('item 1 sem session_id', bodies[1].session_id === undefined);
	ok('outputs distintos', out5[0][0].json.content === 'r1' && out5[0][1].json.content === 'r2');

	// 6. loadOptions.listAgents — mapeia e filtra id vazio
	console.log('\n[loadOptions] listAgents');
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({ data: [{ id: 'ag1', commercial_name: 'Bot Pro', bio: 'x' }, { id: '', name: 'sem id' }] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	const opts = await node.methods.loadOptions.listAgents.call({
		getCredentials: async () => ({ apiKey: 'zhn_live_' + 'a'.repeat(24) }),
		getNodeParameter: (_n, def) => def,
	});
	ok('1 opção (filtra id vazio)', opts.length === 1);
	ok('name = commercial_name', opts[0].name === 'Bot Pro');
	ok('value = id', opts[0].value === 'ag1');

	// 7. includeRaw=true inclui raw
	console.log('\n[execute] includeRaw=true');
	globalThis.fetch = async () =>
		sse([
			'event: response\ndata: {"content":"x"}\n\n',
			'event: metrics\ndata: {"usage":{"total_tokens":3}}\n\n',
		]);
	const out7 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: { includeRaw: true } }),
	);
	ok('raw presente e é array', Array.isArray(out7[0][0].json.raw) && out7[0][0].json.raw.length >= 2);

	// #80 — contrato de entrada 0.6 no nó Zihin Agent
	console.log('\n[#80] entrada estruturada');
	let b80;
	const cap80 = (meta) => async (_u, init) => {
		b80 = JSON.parse(init.body);
		return sse([`event: metadata\ndata: ${JSON.stringify(meta)}\n\n`, 'event: response\ndata: {"content":"ok","session_id":"derivada"}\n\n', 'event: done\ndata: {"outcome":"COMPLETED"}\n\n']);
	};
	globalThis.fetch = cap80({ session_id: 'derivada', accepted_fields: ['consumer_key', 'context', 'bindings', 'session_from'], ignored_fields: [{ field: 'context.nota', reason: 'redacted' }] });
	const o80 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { consumer: '5511', context: '{"cliente":"Ana","nota":"x"}', bindings: { hash: 'h-1' }, sessionFrom: 'hash, cliente' } }),
	);
	const j80 = o80[0][0].json;
	ok('corpo: consumer_key/context/bindings/session_from', b80.consumer_key === '5511' && b80.context.cliente === 'Ana' && b80.bindings.hash === 'h-1' && b80.session_from.join() === 'hash,cliente');
	ok('saida: acceptedFields/ignoredFields/outcome/sessionId', j80.acceptedFields.includes('session_from') && j80.ignoredFields[0].reason === 'redacted' && j80.outcome === 'COMPLETED' && j80.sessionId === 'derivada');
	globalThis.fetch = cap80({ session_id: 's' });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { context: '{}', bindings: '{}' } }));
	ok('defaults "{}" nao vao no corpo', !('context' in b80) && !('bindings' in b80));
	const bad80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { context: '{x' } }, { continueOnFail: true }));
	ok('JSON invalido → erro claro', /Context must be a JSON object/.test(bad80[0][0].json.error));
	globalThis.fetch = cap80({ session_id: 's', accepted_fields: ['consumer_key'] });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { consumer: 5511999 } }));
	ok('Consumer Key numerica (expressao) vira texto, sem TypeError', b80.consumer_key === '5511999');

	console.log('\n[0.7] Client Message ID');
	const UUID07 = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
	globalThis.fetch = cap80({ session_id: 's', accepted_fields: ['client_message_id'] });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: { clientMessageId: UUID07 } }));
	ok('clientMessageId vai como client_message_id', b80.client_message_id === UUID07);
	for (const bad of [123, { a: 1 }]) {
		const r = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: { clientMessageId: bad } }, { continueOnFail: true }));
		ok(`clientMessageId ${JSON.stringify(bad)} (expressao) → erro config legivel`, r[0][0].json.kind === 'config' && /UUID/.test(r[0][0].json.error));
	}
	globalThis.fetch = cap80({ session_id: 's' });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', options: { clientMessageId: '' } }));
	ok('clientMessageId vazio nao vai no corpo', !('client_message_id' in b80));
	// REFUSED chega como erro, nao como item com o texto neutro
	globalThis.fetch = async () => sse(['event: metadata\ndata: {"session_id":"s","execution_id":"ex-r"}\n\n', 'event: metrics\ndata: {"execution_id":"ex-r"}\n\n', 'event: response\ndata: {"content":"Não consigo ajudar com esse pedido.","session_id":"s"}\n\n', 'event: done\ndata: {"outcome":"REFUSED","execution_id":"ex-r"}\n\n']);
	const rRef = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '' }, { continueOnFail: true }));
	ok('REFUSED → item de erro (kind blocked, code REFUSED), nunca o texto neutro como content', rRef[0][0].json.kind === 'blocked' && rRef[0][0].json.code === 'REFUSED' && rRef[0][0].json.content === undefined);
	const sf80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { bindings: '{"a":"1"}', sessionFrom: 7 } }, { continueOnFail: true }));
	ok('Session From numerico nao some em silencio → config', sf80[0][0].json.kind === 'config');
	globalThis.fetch = cap80({ accepted_fields: [], ignored_fields: [{ field: 'context', reason: 'requires_admin_api_key' }] });
	const deny80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '', structuredInput: { context: '{"a":1}' } }, { continueOnFail: true }));
	ok('key sem papel → continueOnFail com kind=config', deny80[0][0].json.kind === 'config' && /admin\/owner/.test(deny80[0][0].json.error));
	globalThis.fetch = async () =>
		sse(['event: metadata\ndata: {"session_id":"s-t"}\n\n', 'event: response\ndata: {"content":"falha"}\n\n', 'event: done\ndata: {"outcome":"TIMEOUT","timed_out":true,"timeout_clock":"turn"}\n\n']);
	const to80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'oi', sessionId: '' }, { continueOnFail: true }));
	ok('TIMEOUT do turno → erro com kind=timeout e sessionId para retomar', to80[0][0].json.kind === 'timeout' && to80[0][0].json.sessionId === 's-t');

	// #92 — timeout do nó de mídia acima do teto do BE por operação
	console.log('\n[#92] timeout do nó de mídia');
	const { Zihin, MEDIA_TIMEOUT_DEFAULTS_MS } = require(path.join(pkgDir, 'dist/nodes/Zihin/Zihin.node.js'));
	ok('defaults acima do teto do BE (transcribe 390s, analyze/parse 180s)', MEDIA_TIMEOUT_DEFAULTS_MS.transcribe > 390000 && MEDIA_TIMEOUT_DEFAULTS_MS.analyze > 180000 && MEDIA_TIMEOUT_DEFAULTS_MS.parse > 180000);
	const media = new Zihin();
	const timeoutOpt = media.description.properties.find((p) => p.name === 'options').options.find((o) => o.name === 'timeout');
	ok('opcao timeout: default 0 (automatico) e max acima de 390s', timeoutOpt.default === 0 && timeoutOpt.typeOptions.maxValue >= 395000);
	// Usa o helper HTTP do n8n (não o fetch global: o undici desiste aos 300s sem headers).
	const reqs = [];
	const cancel = new AbortController().signal;
	let reply = { statusCode: 200, body: { success: true, data: { text: 'ok' } } };
	const mctx = (params) => ({
		...ctx(params, { cancelSignal: cancel }),
		getNode: () => ({ name: 'Zihin' }),
		helpers: {
			httpRequest: async () => {
				throw new Error('o nó de mídia deve autenticar pela credencial (httpRequestWithAuthentication)');
			},
			httpRequestWithAuthentication: async function (cred, o) {
				reqs.push({ ...o, _cred: cred });
				return reply;
			},
		},
	});
	globalThis.fetch = async () => {
		throw new Error('o nó de mídia não deve usar o fetch global');
	};
	const mOut = await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: {} }));
	await media.execute.call(mctx({ resource: 'document', operation: 'parse', document: 'https://x/a.pdf', options: {} }));
	await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: { timeout: 50000 } }));
	await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: { timeout: 3e9 } }));
	ok('transcribe 395s; parse 185s; explicito vence; expressao gigante limitada a 900s', reqs[0].timeout === 395000 && reqs[1].timeout === 185000 && reqs[2].timeout === 50000 && reqs[3].timeout === 900000);
	ok('autentica pela credencial zihinApi, sem X-Api-Key manual', reqs[0]._cred === 'zihinApi' && !('X-Api-Key' in (reqs[0].headers || {})));
	ok('helper do n8n com abortSignal do cancelamento e status sem throw', reqs[0].abortSignal === cancel && reqs[0].ignoreHttpStatusErrors === true && reqs[0].json === true && reqs[0].body.audio === 'https://x/a.mp3');
	ok('saida de midia preservada', mOut[0][0].json.text === 'ok' && mOut[0][0].json._meta.success === true);
	reply = { statusCode: 502, body: '<html>bad gateway</html>' };
	const m502 = await media.execute.call({ ...mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: {} }), continueOnFail: () => true });
	ok('5xx com corpo HTML → erro com o status, sem ecoar o corpo', /502/.test(m502[0][0].json.error) && !/html/.test(m502[0][0].json.error));

	console.log(`\n==== ${pass} passou, ${fail} falhou ====`);
	process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
	console.error('ERRO INESPERADO:', e);
	process.exit(2);
});
