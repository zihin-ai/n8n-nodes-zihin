

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

	console.log('\n[execute] successful execution');
	globalThis.fetch = async (url) => {
		ok('POST to the agent stream endpoint', String(url).includes('/api/v2/agents/ag-1/stream'));
		return sse([
			'event: response\ndata: {"content":"Hello!","session_id":"s-1"}\n\n',
			'event: metrics\ndata: {"usage":{"total_tokens":12},"model_config":{"model":"openai.gpt-4o"}}\n\n',
		]);
	};
	const node = new ZihinAgent();
	const out = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }),
	);
	const json = out[0][0].json;
	ok('content mapped', json.content === 'Hello!');
	ok('sessionId mapped', json.sessionId === 's-1');
	ok('model mapped from metrics', json.model === 'openai.gpt-4o');
	ok('usage mapped', json.usage && json.usage.totalTokens === 12);
	ok('raw events omitted by default', json.raw === undefined);

	console.log('\n[execute] requested timeout reaches the server');
	let sentBody = null;
	globalThis.fetch = async (_url, init) => {
		sentBody = JSON.parse(init.body);
		return sse(['event: response\ndata: {"content":"ok"}\n\n']);
	};
	await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: { timeoutMs: 25000 } }),
	);
	ok('options.timeout_ms sent to the server', sentBody.options && sentBody.options.timeout_ms === 25000);

	sentBody = null;
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }));
	ok(
		'no configured timeout leaves the server default unchanged',
		!sentBody.options || sentBody.options.timeout_ms === undefined,
	);

	console.log('\n[execute] contentSource is exposed');
	globalThis.fetch = async () => sse(['event: response\ndata: {"content":"final"}\n\n']);
	const src = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }),
	);
	ok('contentSource=response', src[0][0].json.contentSource === 'response');

	globalThis.fetch = async () => sse(['event: token\ndata: {"content":"parcial cru"}\n\n']);
	const partial = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }),
	);
	ok('partial output marked as tokens', partial[0][0].json.contentSource === 'tokens');

	console.log('\n[execute] host cancellation reaches the server');
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
				{ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} },
				{ cancelSignal: controller.signal },
			),
		);
	} catch (e) {
		cancelErr = e;
	}
	ok('signal forwarded to fetch', sawSignal);
	ok('host cancellation aborts the request', cancelErr !== null);

	console.log('\n[execute] blocks/iterations/executionTimeMs are exposed');
	globalThis.fetch = async () =>
		sse([
			'event: response\ndata: {"content":"ok","blocks":[{"type":"card"}]}\n\n',
			'event: metrics\ndata: {"iterations":3,"execution_time_ms":812}\n\n',
		]);
	const rich = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }),
	);
	ok('blocks exposed', Array.isArray(rich[0][0].json.blocks) && rich[0][0].json.blocks.length === 1);
	ok('iterations exposed', rich[0][0].json.iterations === 3);
	ok('executionTimeMs exposed', rich[0][0].json.executionTimeMs === 812);

	console.log('\n[execute] error with continueOnFail');
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	const out2 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }, { continueOnFail: true }),
	);
	ok('error item returned', typeof out2[0][0].json.error === 'string');
	ok('error does not expose the key', !out2[0][0].json.error.includes('zhn_live_'));

	console.log('\n[execute] error without continueOnFail throws');
	let threw = false;
	try {
		await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: {} }));
	} catch (e) {
		threw = true;
		ok('sanitized message', !String(e.message).includes('zhn_live_'));
	}
	ok('threw', threw);

	console.log('\n[execute] options → request (snake_case + baseUrl)');
	let captured;
	globalThis.fetch = async (url, init) => {
		captured = { url: String(url), body: JSON.parse(init.body) };
		return sse(['event: response\ndata: {"content":"x"}\n\n']);
	};
	await node.execute.call(
		ctx({
			agentId: 'ag-1',
			message: 'hello',
			sessionId: '',
			options: { temperature: 0.2, maxTokens: 99, baseUrl: 'https://staging.llm.zihin.ai' },
		}),
	);
	ok('URL uses custom baseUrl', captured.url.startsWith('https://staging.llm.zihin.ai/api/v2/agents/ag-1/stream'));

	ok('temperature not forwarded', captured.body.options?.temperature === undefined);
	ok('maxTokens not forwarded', captured.body.options?.max_tokens === undefined);

	console.log('\n[execute] multiple items with pairing and sessions');
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
	ok('two output items', out5[0].length === 2);
	ok('correct pairedItem.item', out5[0][1].pairedItem.item === 1);
	ok('item zero sends session_id', bodies[0].session_id === 's-A');
	ok('item one omits session_id', bodies[1].session_id === undefined);
	ok('distinct outputs', out5[0][0].json.content === 'r1' && out5[0][1].json.content === 'r2');

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
	ok('one option after filtering empty IDs', opts.length === 1);
	ok('name = commercial_name', opts[0].name === 'Bot Pro');
	ok('value = id', opts[0].value === 'ag1');

	console.log('\n[execute] includeRaw=true');
	globalThis.fetch = async () =>
		sse([
			'event: response\ndata: {"content":"x"}\n\n',
			'event: metrics\ndata: {"usage":{"total_tokens":3}}\n\n',
		]);
	const out7 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: { includeRaw: true } }),
	);
	ok('raw events are present as an array', Array.isArray(out7[0][0].json.raw) && out7[0][0].json.raw.length >= 2);

	console.log('\n[#80] structured input');
	let b80;
	const cap80 = (meta) => async (_u, init) => {
		b80 = JSON.parse(init.body);
		return sse([`event: metadata\ndata: ${JSON.stringify(meta)}\n\n`, 'event: response\ndata: {"content":"ok","session_id":"derived"}\n\n', 'event: done\ndata: {"outcome":"COMPLETED"}\n\n']);
	};
	globalThis.fetch = cap80({ session_id: 'derived', accepted_fields: ['consumer_key', 'context', 'bindings', 'session_from'], ignored_fields: [{ field: 'context.nota', reason: 'redacted' }] });
	const o80 = await node.execute.call(
		ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { consumer: '5511', context: '{"customer":"Ana","nota":"x"}', bindings: { hash: 'h-1' }, sessionFrom: 'hash, customer' } }),
	);
	const j80 = o80[0][0].json;
	ok('request body includes consumer_key/context/bindings/session_from', b80.consumer_key === '5511' && b80.context.customer === 'Ana' && b80.bindings.hash === 'h-1' && b80.session_from.join() === 'hash,customer');
	ok('output includes acceptedFields/ignoredFields/outcome/sessionId', j80.acceptedFields.includes('session_from') && j80.ignoredFields[0].reason === 'redacted' && j80.outcome === 'COMPLETED' && j80.sessionId === 'derived');
	globalThis.fetch = cap80({ session_id: 's' });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { context: '{}', bindings: '{}' } }));
	ok('empty default objects are omitted from the body', !('context' in b80) && !('bindings' in b80));
	const bad80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { context: '{x' } }, { continueOnFail: true }));
	ok('invalid JSON produces a clear error', /Context must be a JSON object/.test(bad80[0][0].json.error));
	globalThis.fetch = cap80({ session_id: 's', accepted_fields: ['consumer_key'] });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { consumer: 5511999 } }));
	ok('numeric Consumer Key expression becomes text without a TypeError', b80.consumer_key === '5511999');

	console.log('\n[0.7] Client Message ID');
	const UUID07 = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
	globalThis.fetch = cap80({ session_id: 's', accepted_fields: ['client_message_id'] });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: { clientMessageId: UUID07 } }));
	ok('clientMessageId sent as client_message_id', b80.client_message_id === UUID07);
	for (const bad of [123, { a: 1 }]) {
		const r = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: { clientMessageId: bad } }, { continueOnFail: true }));
		ok(`clientMessageId ${JSON.stringify(bad)} expression produces a readable config error`, r[0][0].json.kind === 'config' && /UUID/.test(r[0][0].json.error));
	}
	globalThis.fetch = cap80({ session_id: 's' });
	await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', options: { clientMessageId: '' } }));
	ok('empty clientMessageId omitted from the body', !('client_message_id' in b80));

	globalThis.fetch = async () => sse(['event: metadata\ndata: {"session_id":"s","execution_id":"ex-r"}\n\n', 'event: metrics\ndata: {"execution_id":"ex-r"}\n\n', 'event: response\ndata: {"content":"I cannot help with that request.","session_id":"s"}\n\n', 'event: done\ndata: {"outcome":"REFUSED","execution_id":"ex-r"}\n\n']);
	const rRef = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '' }, { continueOnFail: true }));
	ok('REFUSED produces a blocked error, not a neutral response as content', rRef[0][0].json.kind === 'blocked' && rRef[0][0].json.code === 'REFUSED' && rRef[0][0].json.content === undefined);
	const sf80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { bindings: '{"a":"1"}', sessionFrom: 7 } }, { continueOnFail: true }));
	ok('numeric Session From raises a configuration error', sf80[0][0].json.kind === 'config');
	globalThis.fetch = cap80({ accepted_fields: [], ignored_fields: [{ field: 'context', reason: 'requires_admin_api_key' }] });
	const deny80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '', structuredInput: { context: '{"a":1}' } }, { continueOnFail: true }));
	ok('insufficient key permissions produce a configuration error', deny80[0][0].json.kind === 'config' && /admin\/owner/.test(deny80[0][0].json.error));
	globalThis.fetch = async () =>
		sse(['event: metadata\ndata: {"session_id":"s-t"}\n\n', 'event: response\ndata: {"content":"failure"}\n\n', 'event: done\ndata: {"outcome":"TIMEOUT","timed_out":true,"timeout_clock":"turn"}\n\n']);
	const to80 = await node.execute.call(ctx({ agentId: 'ag-1', message: 'hello', sessionId: '' }, { continueOnFail: true }));
	ok('turn TIMEOUT preserves sessionId and the timeout error kind', to80[0][0].json.kind === 'timeout' && to80[0][0].json.sessionId === 's-t');

	console.log('\n[#92] media node timeout');
	const { Zihin, MEDIA_TIMEOUT_DEFAULTS_MS } = require(path.join(pkgDir, 'dist/nodes/Zihin/Zihin.node.js'));
	ok('defaults exceed server limits for transcription, analysis and parsing', MEDIA_TIMEOUT_DEFAULTS_MS.transcribe > 390000 && MEDIA_TIMEOUT_DEFAULTS_MS.analyze > 180000 && MEDIA_TIMEOUT_DEFAULTS_MS.parse > 180000);
	const media = new Zihin();
	const timeoutOpt = media.description.properties.find((p) => p.name === 'options').options.find((o) => o.name === 'timeout');
	ok('timeout defaults to automatic and permits values above 390s', timeoutOpt.default === 0 && timeoutOpt.typeOptions.maxValue >= 395000);

	const reqs = [];
	const cancel = new AbortController().signal;
	let reply = { statusCode: 200, body: { success: true, data: { text: 'ok' } } };
	const mctx = (params) => ({
		...ctx(params, { cancelSignal: cancel }),
		getNode: () => ({ name: 'Zihin' }),
		helpers: {
			httpRequest: async () => {
				throw new Error('media node must use httpRequestWithAuthentication');
			},
			httpRequestWithAuthentication: async function (cred, o) {
				reqs.push({ ...o, _cred: cred });
				return reply;
			},
		},
	});
	globalThis.fetch = async () => {
		throw new Error('media node must not use global fetch');
	};
	const mOut = await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: {} }));
	await media.execute.call(mctx({ resource: 'document', operation: 'parse', document: 'https://x/a.pdf', options: {} }));
	await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: { timeout: 50000 } }));
	await media.execute.call(mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: { timeout: 3e9 } }));
	ok('transcribe 395s; parse 185s; explicit override wins; maximum 900s', reqs[0].timeout === 395000 && reqs[1].timeout === 185000 && reqs[2].timeout === 50000 && reqs[3].timeout === 900000);
	ok('uses zihinApi credentials without a manual X-Api-Key header', reqs[0]._cred === 'zihinApi' && !('X-Api-Key' in (reqs[0].headers || {})));
	ok('n8n helper receives cancellation and returns HTTP error statuses', reqs[0].abortSignal === cancel && reqs[0].ignoreHttpStatusErrors === true && reqs[0].json === true && reqs[0].body.audio === 'https://x/a.mp3');
	ok('media output preserved', mOut[0][0].json.text === 'ok' && mOut[0][0].json._meta.success === true);
	reply = { statusCode: 502, body: '<html>bad gateway</html>' };
	const m502 = await media.execute.call({ ...mctx({ resource: 'audio', operation: 'transcribe', audio: 'https://x/a.mp3', options: {} }), continueOnFail: () => true });
	ok('5xx HTML response reports the status without exposing the body', /502/.test(m502[0][0].json.error) && !/html/.test(m502[0][0].json.error));

	console.log(`\n==== ${pass} passed, ${fail} failed ====`);
	process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
	console.error('UNEXPECTED ERROR:', e);
	process.exit(2);
});
