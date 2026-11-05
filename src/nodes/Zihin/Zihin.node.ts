import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import { validateBaseUrl, validateApiKeyFormat, sanitizeApiError } from '../../utils/security';

/**
 * Deadline local por operação, logo ACIMA do teto do BE para cada rota de mídia
 * (zihin-agent-builder#515, `config/express.js`: transcribe 390s; analyze/parse 180s). Abaixo
 * dele o nó abortaria um trabalho que o servidor segue processando — e cobrando (#92).
 */
export const MEDIA_TIMEOUT_DEFAULTS_MS = {
	transcribe: 395000,
	analyze: 185000,
	parse: 185000,
} as const;
export const MEDIA_TIMEOUT_MAX_MS = 900000;

interface ZihinApiResponse {
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
	execution_time_ms?: number;
}

/**
 * Zihin App Node - Media Processing
 * Provides Image Analysis, Audio Transcription, and Document Parsing
 */
export class Zihin implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zihin',
		name: 'zihin',
		hidden: true,
		icon: 'file:zihin.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Process media with Zihin AI - Image Analysis, Audio Transcription, Document Parsing',
		defaults: {
			name: 'Zihin',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'zihinApi',
				required: true,
			},
		],
		properties: [
			// ============================================
			// Resource Selector
			// ============================================
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Image',
						value: 'image',
						description: 'Analyze images with Vision AI',
					},
					{
						name: 'Audio',
						value: 'audio',
						description: 'Transcribe audio files',
					},
					{
						name: 'Document',
						value: 'document',
						description: 'Parse and extract content from documents',
					},
				],
				default: 'image',
			},

			// ============================================
			// IMAGE Operations
			// ============================================
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['image'],
					},
				},
				options: [
					{
						name: 'Analyze',
						value: 'analyze',
						description: 'Analyze image with Vision AI (GPT-4o or Claude)',
						action: 'Analyze image',
					},
				],
				default: 'analyze',
			},
			// Image fields
			{
				displayName: 'Image',
				name: 'image',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['image'],
						operation: ['analyze'],
					},
				},
				default: '',
				placeholder: 'https://example.com/image.jpg or data:image/png;base64,...',
				description: 'URL or base64 data URI of the image to analyze',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['image'],
						operation: ['analyze'],
					},
				},
				default: '',
				placeholder: 'Describe this image in detail',
				description: 'Instructions for the analysis. Leave empty for default description.',
			},
			{
				displayName: 'Additional Options',
				name: 'imageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['image'],
						operation: ['analyze'],
					},
				},
				options: [
					{
						displayName: 'Extract Text (OCR)',
						name: 'extractText',
						type: 'boolean',
						default: false,
						description: 'Whether to extract text from the image using OCR',
					},
					{
						displayName: 'Detail Level',
						name: 'detail',
						type: 'options',
						options: [
							{ name: 'Auto', value: 'auto' },
							{ name: 'Low', value: 'low' },
							{ name: 'High', value: 'high' },
						],
						default: 'auto',
						description: 'Level of detail for analysis. High uses more tokens.',
					},
					{
						displayName: 'Provider',
						name: 'provider',
						type: 'options',
						options: [
							{ name: 'Auto (Best Available)', value: 'auto' },
							{ name: 'OpenAI (GPT-4o)', value: 'openai' },
							{ name: 'Anthropic (Claude)', value: 'anthropic' },
						],
						default: 'auto',
						description: 'Which AI provider to use for analysis',
					},
				],
			},

			// ============================================
			// AUDIO Operations
			// ============================================
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['audio'],
					},
				},
				options: [
					{
						name: 'Transcribe',
						value: 'transcribe',
						description: 'Transcribe audio to text',
						action: 'Transcribe audio',
					},
				],
				default: 'transcribe',
			},
			// Audio fields
			{
				displayName: 'Audio',
				name: 'audio',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['audio'],
						operation: ['transcribe'],
					},
				},
				default: '',
				placeholder: 'https://example.com/audio.mp3 or data:audio/mp3;base64,...',
				description: 'URL or base64 data URI of the audio file',
			},
			{
				displayName: 'Additional Options',
				name: 'audioOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['audio'],
						operation: ['transcribe'],
					},
				},
				options: [
					{
						displayName: 'Language',
						name: 'language',
						type: 'options',
						options: [
							{ name: 'Auto Detect', value: 'auto' },
							{ name: 'CSV', value: 'csv' },
							{ name: 'Excel (XLSX)', value: 'xlsx' },
							{ name: 'PDF', value: 'pdf' },
							{ name: 'Word (DOCX)', value: 'docx' },
						],
						default: 'auto',
						description: 'Type of document',
					},
					{
						displayName: 'Extract Mode',
						name: 'extractMode',
						type: 'options',
						options: [
							{ name: 'Text Only', value: 'text' },
							{ name: 'Tables Only', value: 'tables' },
							{ name: 'All (Text + Tables)', value: 'all' },
						],
						default: 'text',
						description: 'What to extract from the document',
					},
					{
						displayName: 'Sheet Name',
						name: 'sheetName',
						type: 'string',
						default: '',
						placeholder: 'Sheet1',
						description: 'For Excel files: specific sheet to parse (default: first sheet)',
					},
					{
						displayName: 'Max Pages',
						name: 'maxPages',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 100,
						},
						default: 0,
						description: 'For PDFs: maximum pages to parse (0 = no limit)',
					},
				],
			},

			// ============================================
			// Global Options
			// ============================================
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Base URL Override',
						name: 'baseUrl',
						type: 'string',
						default: '',
						placeholder: 'https://llm.zihin.ai',
						description: 'Custom base URL for the API',
					},
					{
						displayName: 'Allow Custom Base URL',
						name: 'allowCustomBaseUrl',
						type: 'boolean',
						default: false,
						description: 'Whether to allow non-Zihin domain URLs',
					},
					{
						displayName: 'Allow Localhost (Dev Only)',
						name: 'allowLocalhost',
						type: 'boolean',
						default: false,
						description: 'Whether to allow localhost URLs for development',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						typeOptions: {
							minValue: 0,
							maxValue: 900000,
						},
						default: 0,
						description: 'Request timeout in milliseconds, covering the whole request. 0 = automatic: just above the Zihin limit for each operation (transcribe 395s, image analyze and document parse 185s). A lower value can abort work the server is still processing and billing. Workflows created before this version saved 120000 here: remove the option to use the automatic value.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Get credentials
		const credentials = await this.getCredentials('zihinApi');
		const apiKey = credentials.apiKey as string;

		// Validate API key
		const apiKeyValidation = validateApiKeyFormat(apiKey);
		if (!apiKeyValidation.valid) {
			throw new NodeOperationError(this.getNode(), 'Invalid API key configuration');
		}

		// Get global options
		const globalOptions = this.getNodeParameter('options', 0, {}) as {
			baseUrl?: string;
			allowCustomBaseUrl?: boolean;
			allowLocalhost?: boolean;
			timeout?: number;
		};

		// Validate base URL
		const urlValidation = validateBaseUrl(globalOptions.baseUrl || '', {
			allowCustomDomains: globalOptions.allowCustomBaseUrl ?? false,
			allowLocalhost: globalOptions.allowLocalhost ?? false,
		});
		if (!urlValidation.valid) {
			throw new NodeOperationError(this.getNode(), `Invalid base URL: ${urlValidation.error}`);
		}
		const baseUrl = urlValidation.sanitizedUrl || 'https://llm.zihin.ai';
		// Desde o #515 do BE cada rota de mídia tem teto próprio e longo (não mais o global de 30s
		// com 408). O default fica logo acima dele: o desfecho do servidor chega antes do nosso abort.
		// `0`/vazio/expressão não resolvida = automático.
		// O teto também vale para expressão (o `maxValue` só limita o widget): acima de 2^31 o timer
		// estoura e vira abort imediato.
		const custom = Number(globalOptions.timeout);
		const timeout =
			Number.isFinite(custom) && custom > 0
				? Math.min(custom, MEDIA_TIMEOUT_MAX_MS)
				: MEDIA_TIMEOUT_DEFAULTS_MS[operation as keyof typeof MEDIA_TIMEOUT_DEFAULTS_MS] ??
					MEDIA_TIMEOUT_DEFAULTS_MS.transcribe;

		for (let i = 0; i < items.length; i++) {
			try {
				let endpoint = '';
				let body: Record<string, unknown> = {};

				// ============================================
				// IMAGE: Analyze
				// ============================================
				if (resource === 'image' && operation === 'analyze') {
					endpoint = '/api/v3/media/image/public/analyze';

					const image = this.getNodeParameter('image', i) as string;
					const prompt = this.getNodeParameter('prompt', i, '') as string;
					const imageOptions = this.getNodeParameter('imageOptions', i, {}) as {
						extractText?: boolean;
						detail?: string;
						provider?: string;
					};

					body = {
						image,
						...(prompt && { prompt }),
						...(imageOptions.extractText && { extract_text: imageOptions.extractText }),
						...(imageOptions.detail && imageOptions.detail !== 'auto' && { detail: imageOptions.detail }),
						...(imageOptions.provider && imageOptions.provider !== 'auto' && { provider: imageOptions.provider }),
					};
				}

				// ============================================
				// AUDIO: Transcribe
				// ============================================
				else if (resource === 'audio' && operation === 'transcribe') {
					endpoint = '/api/v3/media/audio/public/transcribe';

					const audio = this.getNodeParameter('audio', i) as string;
					const audioOptions = this.getNodeParameter('audioOptions', i, {}) as {
						language?: string;
						includeTimestamps?: boolean;
						promptHint?: string;
					};

					body = {
						audio,
						...(audioOptions.language && audioOptions.language !== 'auto' && { language: audioOptions.language }),
						...(audioOptions.includeTimestamps && { include_timestamps: audioOptions.includeTimestamps }),
						...(audioOptions.promptHint && { prompt_hint: audioOptions.promptHint }),
					};
				}

				// ============================================
				// DOCUMENT: Parse
				// ============================================
				else if (resource === 'document' && operation === 'parse') {
					endpoint = '/api/v3/media/document/public/parse';

					const document = this.getNodeParameter('document', i) as string;
					const documentOptions = this.getNodeParameter('documentOptions', i, {}) as {
						fileType?: string;
						extractMode?: string;
						sheetName?: string;
						maxPages?: number;
					};

					body = {
						document,
						...(documentOptions.fileType && documentOptions.fileType !== 'auto' && { file_type: documentOptions.fileType }),
						...(documentOptions.extractMode && { extract_mode: documentOptions.extractMode }),
						...(documentOptions.sheetName && { sheet_name: documentOptions.sheetName }),
						...(documentOptions.maxPages && documentOptions.maxPages > 0 && { max_pages: documentOptions.maxPages }),
					};
				}

				// Helper HTTP do n8n, não o `fetch` global: o undici do Node desiste aos 300s sem headers
				// (`headersTimeout`), e estas rotas só respondem no fim — a transcrição longa (até 390s no
				// BE) morreria antes. Aqui o `timeout` cobre a requisição inteira (corpo incluso), não
				// sobra timer em erro de rede, e cancelar a execução no n8n aborta a chamada.
				const response = (await this.helpers.httpRequest({
					method: 'POST',
					url: `${baseUrl}${endpoint}`,
					headers: {
						'Content-Type': 'application/json',
						'X-Api-Key': apiKey,
					},
					body,
					json: true,
					timeout,
					abortSignal: this.getExecutionCancelSignal?.(),
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				})) as { statusCode: number; body: unknown };

				const ok = response.statusCode >= 200 && response.statusCode < 300;
				// 5xx de proxy pode vir em texto/HTML: vira erro com o status, sem ecoar o corpo.
				const result: ZihinApiResponse =
					response.body && typeof response.body === 'object'
						? (response.body as ZihinApiResponse)
						: { success: false, error: `HTTP ${response.statusCode}` };

				if (!ok || !result.success) {
					const sanitized = sanitizeApiError({
						error: result.error,
						message: result.error,
					});
					throw new NodeOperationError(this.getNode(), sanitized.message);
				}

				// Return the data field directly for easier access in workflows
				returnData.push({
					json: {
						...result.data,
						_meta: {
							success: result.success,
							execution_time_ms: result.execution_time_ms,
						},
					},
					pairedItem: { item: i },
				});

			} catch (error) {
				if (this.continueOnFail()) {
					const sanitized = sanitizeApiError(error);
					returnData.push({
						json: {
							error: sanitized.message,
							success: false,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
