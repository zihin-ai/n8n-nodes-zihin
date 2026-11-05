import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
	sleepWithAbort,
} from 'n8n-workflow';

// Entry `/core`: o núcleo sem timers/`process`/`console` globais (o scanner de nó verificado reprova
// essas referências). Timers vêm do `sleepWithAbort` do n8n — ver `zihinRuntime` abaixo.
import { createClient, sanitizeApiError, ZihinAgentError } from '@zihin/agent-client/core';
import type { ContextValue, ZihinRuntime } from '@zihin/agent-client/core';

/**
 * Aceita objeto ou texto JSON (expressão, campo colado). Vazio → undefined (nada é enviado).
 * Inválido → `null`: o chamador lança o `NodeOperationError` (exigência do lint do n8n).
 */
function parseFlatObject(value: unknown): Record<string, ContextValue> | undefined | null {
	if (value === undefined || value === null || value === '') return undefined;
	let v = value;
	if (typeof v === 'string') {
		if (!v.trim()) return undefined;
		try {
			v = JSON.parse(v);
		} catch {
			return null;
		}
	}
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
	return Object.keys(v).length ? (v as Record<string, ContextValue>) : undefined;
}

/** "a, b" ou ['a','b'] → ['a','b']; vazio → undefined. */
function parseFieldList(value: unknown): string[] | undefined {
	// Número/outro tipo vindo de expressão vira texto e o núcleo valida o nome — nunca some em silêncio.
	const list = Array.isArray(value) ? value : value == null ? [] : String(value).split(',');
	const out = list.map((f) => String(f).trim()).filter(Boolean);
	return out.length ? out : undefined;
}

/** Timers do host n8n; avisos de descontinuação do núcleo vão para o logger da execução. */
function zihinRuntime(logger?: { warn(message: string): void }): ZihinRuntime {
	return {
		sleep: sleepWithAbort,
		warn: (code, message) => logger?.warn(`[${code}] ${message}`),
	};
}

/**
 * Zihin Agent — invokes a hosted Zihin agent over the shared @zihin/agent-client core.
 * The agent runs the full loop (tools, MCP, memory, HITL) under the tenant's RBAC, quota and audit.
 * This is the recommended way to reach Zihin from n8n.
 */
export class ZihinAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zihin Agent',
		name: 'zihinAgent',
		icon: { light: 'file:zihin.svg', dark: 'file:zihin.svg' },
		usableAsTool: true,
		group: ['transform'],
		version: 1,
		subtitle: '={{"agent: " + ($parameter["agentId"] || "")}}',
		description: 'Invoke a Zihin agent (runs the full agent loop: tools, memory, governance)',
		defaults: {
			name: 'Zihin Agent',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'zihinApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Agent Name or ID',
				name: 'agentId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'listAgents',
				},
				required: true,
				default: '',
				description:
					'The agent to invoke. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				required: true,
				default: '',
				description: 'The message to send to the agent',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description:
					'Reuse a session ID to continue a previous conversation. The output returns the session ID to reuse on the next call. Leave empty to start a new conversation.',
			},
			{
				displayName: 'Structured Input (Admin API Key)',
				name: 'structuredInput',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				description:
					'Data sent alongside the message. Requires an admin/owner API key: with any other key the call fails instead of running without it. Never put credentials here — use a tenant secret.',
				options: [
					{
						displayName: 'Bindings (JSON)',
						name: 'bindings',
						type: 'json',
						default: '{}',
						description:
							'Flat JSON object only the agent TOOLS receive (internal IDs, lookup keys). Never shown to the model and never stored. Up to 50 fields, 16,000 characters.',
					},
					{
						displayName: 'Consumer Key',
						// `consumer`, não `consumerKey`: o lint do n8n trata campo terminado em "Key" como
						// segredo (exigiria password). É um identificador, não credencial.
						name: 'consumer',
						type: 'string',
						default: '',
						description:
							'Who the end user is (e.g. a phone number, digits only). Enables per-person memory and controls. Requires an admin/owner API key. To continue conversations a webhook already stored, use the same value the webhook used.',
					},
					{
						displayName: 'Context (JSON)',
						name: 'context',
						type: 'json',
						default: '{}',
						description:
							'Flat JSON object the MODEL reads with the message (e.g. {"customer": "Ana", "plan": "pro"}). Stored with the conversation; values that look like secrets are redacted. Up to 50 fields, 2,000 characters in total.',
					},
					{
						displayName: 'Session From',
						name: 'sessionFrom',
						type: 'string',
						default: '',
						placeholder: 'supplierHash',
						description:
							'1 to 5 comma-separated field names from Context or Bindings. The session ID is derived from their values, so the same values always continue the same conversation (same rule as a webhook "derive"). Put these fields in Bindings: a Context value that looks like a secret is masked and then rejected here. Do not combine with Session ID.',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Allow Custom Base URL',
						name: 'allowCustomBaseUrl',
						type: 'boolean',
						default: false,
						description:
							'Whether to allow a base URL outside the Zihin domain whitelist. The API key is transmitted to that host — only enable for a trusted private deployment (advanced).',
					},
					{
						displayName: 'Allow HTTP / Localhost (Dev Only)',
						name: 'allowHttp',
						type: 'boolean',
						default: false,
						description:
							'Whether to allow http:// and localhost base URLs. For local development against a self-hosted Zihin only — never enable in production (the API key would be sent over plaintext).',
					},
					{
						displayName: 'Base URL',
						name: 'baseUrl',
						type: 'string',
						default: '',
						placeholder: 'https://llm.zihin.ai',
						description:
							'Override the Zihin base URL (e.g. a private deployment). Your API key is sent to this host, so only use a host you trust. Leave empty to use the default.',
					},
					{
						displayName: 'Client Message ID (Idempotency)',
						name: 'clientMessageId',
						type: 'string',
						default: '',
						description:
							'Optional UUID that makes retries safe: sending the same UUID with the same message again never runs a COMPLETED turn twice (the stored answer is replayed; while the first run is still in flight you get a retryable "session busy" error). Best effort: only a finished turn is protected (a turn that was cut off, timed out or failed runs again), and the backend skips the check if its cache is unavailable. Use a NEW UUID per message and never a fixed value: a fixed UUID with a fixed message would return the same stored answer for 24 hours. Requires a Zihin server from October 2026 or later; otherwise the call fails instead of silently running without the guarantee.',
					},
					{
						displayName: 'Include Raw Events',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description: 'Whether to include the raw SSE events in the output (for debugging)',
					},
					{
						displayName: 'Max Tokens (No Effect)',
						name: 'maxTokens',
						type: 'number',
						default: 1024,
						description: 'Deprecated, no effect: the agent uses its own output limit (set it on the agent in the Zihin console). Kept so saved workflows keep loading; will be removed.',
					},
					{
						displayName: 'Temperature (No Effect)',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0.7,
						description: 'Deprecated, no effect: the agent uses its own temperature (set it on the agent in the Zihin console). Kept so saved workflows keep loading; will be removed.',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						typeOptions: { minValue: 1000, maxValue: 900000 },
						default: 200000,
						description: 'Maximum total time for the call, in milliseconds. Keep this above the Zihin stream budget (180s) so the server delivers its own outcome instead of the client aborting blind.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async listAgents(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('zihinApi');
				// Respeita o Base URL custom do nó para que o dropdown busque no mesmo host da execução.
				const options = (this.getNodeParameter('options', {}) as {
					baseUrl?: string;
					allowCustomBaseUrl?: boolean;
					allowHttp?: boolean;
				}) || {};
				const client = createClient({
					apiKey: credentials.apiKey as string,
					baseUrl: options.baseUrl || undefined,
					allowCustomBaseUrl: options.allowCustomBaseUrl,
					allowHttp: options.allowHttp,
					runtime: zihinRuntime(this.logger),
				});
				try {
					const agents = await client.listAgents();
					return agents
						.filter((a) => a.id)
						.map((a) => ({
							name: a.commercialName || a.name || a.id,
							value: a.id,
							description: a.bio,
						}));
				} catch (error) {
					// UX limpa no dropdown em vez de propagar um erro cru.
					const message =
						error instanceof ZihinAgentError ? error.message : sanitizeApiError(error).message;
					throw new NodeOperationError(this.getNode(), `Could not load agents: ${message}`);
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('zihinApi');

		for (let i = 0; i < items.length; i++) {
			try {
				const agentId = this.getNodeParameter('agentId', i) as string;
				const message = this.getNodeParameter('message', i) as string;
				const sessionId = this.getNodeParameter('sessionId', i, '') as string;
				const structured = this.getNodeParameter('structuredInput', i, {}) as {
					consumer?: string;
					context?: unknown;
					bindings?: unknown;
					sessionFrom?: unknown;
				};
				const context = parseFlatObject(structured.context);
				const bindings = parseFlatObject(structured.bindings);
				for (const [label, parsed] of [['Context', context], ['Bindings', bindings]] as const) {
					if (parsed === null) {
						throw new NodeOperationError(
							this.getNode(),
							`${label} must be a JSON object, e.g. {"customer": "Ana"}.`,
							{ itemIndex: i },
						);
					}
				}
				const options = this.getNodeParameter('options', i, {}) as {
					temperature?: number;
					maxTokens?: number;
					timeoutMs?: number;
					baseUrl?: string;
					allowCustomBaseUrl?: boolean;
					allowHttp?: boolean;
					includeRaw?: boolean;
					clientMessageId?: string;
				};

				const client = createClient({
					apiKey: credentials.apiKey as string,
					baseUrl: options.baseUrl || undefined,
					allowCustomBaseUrl: options.allowCustomBaseUrl,
					allowHttp: options.allowHttp,
					runtime: zihinRuntime(this.logger),
				});

				const result = await client.invokeAgent({
					agentId,
					message,
					sessionId: sessionId || undefined,
					clientMessageId: String(options.clientMessageId ?? '').trim() || undefined,
					// Telefone vindo de expressão chega número: o n8n não converte parâmetro string.
					consumerKey: String(structured.consumer ?? '').trim() || undefined,
					context: context ?? undefined,
					bindings: bindings ?? undefined,
					sessionFrom: parseFieldList(structured.sessionFrom),
					includeRaw: options.includeRaw,
					// Cancelar a execução no n8n agora derruba o turno no backend de verdade (o abort
					// desce até a chamada ao provider). Sem repassar o signal, cancelar o workflow
					// deixava o agente rodando sozinho — gastando LLM e tools que ninguém leria.
					signal: this.getExecutionCancelSignal?.(),
					// `temperature`/`maxTokens` não são repassados: o /stream usa a config do agente e
					// os ignoraria (descontinuados no SDK desde a 0.6.1). Ficam no formulário só para
					// workflows salvos continuarem abrindo.
					options: {
						// Vai como `options.timeout_ms` para o backend — é o teto que ELE respeita — e o
						// deadline local fica acima disso, para que o desfecho do servidor chegue antes
						// do nosso abort. Passar isto na config do cliente não alcança o backend.
						// A guarda importa: `minValue` só limita o widget, não uma expressão que
						// resolva para "" / null / 0 — e aí o núcleo lançaria erro de config.
						timeoutMs:
							Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
								? Number(options.timeoutMs)
								: undefined,
					},
				});

				returnData.push({
					json: {
						content: result.content,
						// 'tokens' = o stream caiu antes da resposta final e este texto é a concatenação
						// crua das iterações, com a deliberação do modelo. Ramifique nisto antes de
						// mandar o conteúdo para um canal externo.
						contentSource: result.contentSource,
						sessionId: result.sessionId,
						model: result.model,
						usage: result.usage,
						sources: result.sources,
						blocks: result.blocks,
						iterations: result.iterations,
						executionTimeMs: result.executionTimeMs,
						outcome: result.outcome,
						truncated: result.truncated,
						finishReason: result.finishReason,
						executionId: result.executionId,
						clientMessageId: result.clientMessageId,
						// true = resposta REPETIDA de um turno anterior com o mesmo Client Message ID (sem usage).
						idempotentReplay: result.idempotentReplay,
						// Resposta enlatada de gate (atendimento humano, denylist): nenhum modelo rodou.
						gated: result.gated,
						acceptedFields: result.acceptedFields,
						// Avisos do servidor (ex.: `redacted` — valor do Context alterado pela redação).
						ignoredFields: result.ignoredFields,
						...(options.includeRaw ? { raw: result.raw } : {}),
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				// ZihinAgentError já vem sanitizado; outros erros passam por sanitizeApiError
				// (preserva diagnóstico sem arriscar vazar key/request-id/stack).
				const message =
					error instanceof ZihinAgentError ? error.message : sanitizeApiError(error).message;
				if (this.continueOnFail()) {
					// Campos para ramificar no fluxo: `kind` (timeout, blocked, config…), `retryable` e
					// os ids para suporte. Tudo já vem sanitizado do núcleo.
					const details =
						error instanceof ZihinAgentError
							? {
									kind: error.kind,
									code: error.code,
									retryable: error.retryable,
									requestId: error.requestId,
									executionId: error.executionId,
									sessionId: error.sessionId,
									timeoutClock: error.timeoutClock,
								}
							: {};
					returnData.push({ json: { error: message, ...details }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
