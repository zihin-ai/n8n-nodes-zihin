/**
 * Security utilities for n8n-nodes-zihin
 * Provides URL validation, payload limits, error sanitization, and HMAC signing
 *
 * @module utils/security
 */

import { createHmac, randomBytes } from 'crypto';

// ============================================
// 1. URL Validation (SSRF Prevention)
// ============================================

const PRIVATE_IP_PATTERNS = [
	/^127\./,                          // 127.0.0.0/8 (localhost)
	/^10\./,                           // 10.0.0.0/8 (private)
	/^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // 172.16.0.0/12 (private)
	/^192\.168\./,                     // 192.168.0.0/16 (private)
	/^169\.254\./,                     // 169.254.0.0/16 (link-local)
	/^0\./,                            // 0.0.0.0/8
	/^::1$/,                           // IPv6 localhost
	/^fe80:/i,                         // IPv6 link-local
	/^fc00:/i,                         // IPv6 unique local
	/^fd00:/i,                         // IPv6 unique local
];

const BLOCKED_HOSTNAMES = [
	'localhost',
	'localtest.me',
	'metadata.google.internal',        // GCP metadata
	'169.254.169.254',                 // AWS/Azure/GCP metadata
	'metadata.azure.com',
];

const ALLOWED_ZIHIN_DOMAINS = [
	'llm.zihin.ai',
	'api.zihin.ai',
	'staging.llm.zihin.ai',
	'dev.llm.zihin.ai',
];

export interface UrlValidationResult {
	valid: boolean;
	error?: string;
	sanitizedUrl?: string;
}

export interface UrlValidationOptions {
	allowCustomDomains?: boolean;
	allowHttp?: boolean;
	allowLocalhost?: boolean;  // For development/testing
}

/**
 * Validates a base URL for SSRF prevention
 * @param url - The URL to validate
 * @param options - Validation options
 * @returns Validation result with sanitized URL or error
 */
export function validateBaseUrl(
	url: string,
	options: UrlValidationOptions = {},
): UrlValidationResult {
	// Empty/default URL is allowed
	if (!url || url.trim() === '') {
		return { valid: true, sanitizedUrl: 'https://llm.zihin.ai' };
	}

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname;

		// Check if this is localhost (for development)
		const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

		// Allow localhost when explicitly enabled (development mode)
		if (isLocalhost && options.allowLocalhost) {
			// Allow HTTP for localhost in dev mode
			const sanitizedUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
			return { valid: true, sanitizedUrl };
		}

		// 1. Protocol validation (HTTPS only by default)
		if (!options.allowHttp && parsed.protocol !== 'https:') {
			return {
				valid: false,
				error: 'Only HTTPS URLs are allowed for security reasons',
			};
		}

		// 2. Block private IP ranges
		for (const pattern of PRIVATE_IP_PATTERNS) {
			if (pattern.test(hostname)) {
				return {
					valid: false,
					error: 'Private IP addresses are not allowed',
				};
			}
		}

		// 3. Block known dangerous hostnames
		for (const blocked of BLOCKED_HOSTNAMES) {
			if (blocked.startsWith('*')) {
				const suffix = blocked.slice(1);
				if (hostname.endsWith(suffix)) {
					return { valid: false, error: 'This hostname is not allowed' };
				}
			} else if (hostname === blocked || hostname.endsWith('.' + blocked)) {
				return { valid: false, error: 'This hostname is not allowed' };
			}
		}

		// 4. Whitelist mode (only Zihin domains) unless custom domains allowed
		if (!options.allowCustomDomains) {
			const isAllowed = ALLOWED_ZIHIN_DOMAINS.some(
				(domain) => hostname === domain || hostname.endsWith('.' + domain),
			);
			if (!isAllowed) {
				return {
					valid: false,
					error: `Only Zihin domains are allowed. Use 'Allow Custom Base URL' option for custom endpoints.`,
				};
			}
		}

		// Remove trailing slash for consistency
		const sanitizedUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');

		return { valid: true, sanitizedUrl };
	} catch {
		return { valid: false, error: 'Invalid URL format' };
	}
}

// ============================================
// 2. Payload Size Limits
// ============================================

export interface PayloadLimits {
	maxPromptBytes: number;          // Default: 100KB
	maxMessageCount: number;         // Default: 100 messages
	maxSingleMessageBytes: number;   // Default: 50KB per message
	maxTotalPayloadBytes: number;    // Default: 500KB
}

const DEFAULT_LIMITS: PayloadLimits = {
	maxPromptBytes: 100 * 1024,       // 100KB
	maxMessageCount: 100,
	maxSingleMessageBytes: 50 * 1024, // 50KB
	maxTotalPayloadBytes: 500 * 1024, // 500KB
};

export interface PayloadValidationResult {
	valid: boolean;
	error?: string;
	truncated?: boolean;
	details?: {
		promptBytes?: number;
		messageCount?: number;
		largestMessageBytes?: number;
		totalBytes?: number;
	};
}

/**
 * Validates prompt size against configured limits
 * @param prompt - The prompt text to validate
 * @param limits - Optional custom limits
 * @returns Validation result with size details
 */
export function validatePromptSize(
	prompt: string,
	limits: Partial<PayloadLimits> = {},
): PayloadValidationResult {
	const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
	const bytes = Buffer.byteLength(prompt, 'utf8');

	if (bytes > effectiveLimits.maxPromptBytes) {
		return {
			valid: false,
			error: `Prompt size (${Math.round(bytes / 1024)}KB) exceeds maximum allowed (${Math.round(effectiveLimits.maxPromptBytes / 1024)}KB)`,
			details: { promptBytes: bytes },
		};
	}

	return { valid: true, details: { promptBytes: bytes } };
}

/**
 * Validates messages array against configured limits
 * @param messages - Array of messages to validate
 * @param limits - Optional custom limits
 * @returns Validation result with message details
 */
export function validateMessages(
	messages: Array<{ role: string; content: string; [key: string]: unknown }>,
	limits: Partial<PayloadLimits> = {},
): PayloadValidationResult {
	const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };

	// Check message count
	if (messages.length > effectiveLimits.maxMessageCount) {
		return {
			valid: false,
			error: `Message count (${messages.length}) exceeds maximum allowed (${effectiveLimits.maxMessageCount})`,
			details: { messageCount: messages.length },
		};
	}

	// Check individual message sizes and total
	let totalBytes = 0;
	let largestMessageBytes = 0;

	for (let i = 0; i < messages.length; i++) {
		const msgBytes = Buffer.byteLength(JSON.stringify(messages[i]), 'utf8');
		totalBytes += msgBytes;
		largestMessageBytes = Math.max(largestMessageBytes, msgBytes);

		if (msgBytes > effectiveLimits.maxSingleMessageBytes) {
			return {
				valid: false,
				error: `Message ${i + 1} size (${Math.round(msgBytes / 1024)}KB) exceeds maximum allowed (${Math.round(effectiveLimits.maxSingleMessageBytes / 1024)}KB)`,
				details: { messageCount: messages.length, largestMessageBytes: msgBytes },
			};
		}
	}

	if (totalBytes > effectiveLimits.maxTotalPayloadBytes) {
		return {
			valid: false,
			error: `Total payload size (${Math.round(totalBytes / 1024)}KB) exceeds maximum allowed (${Math.round(effectiveLimits.maxTotalPayloadBytes / 1024)}KB)`,
			details: { messageCount: messages.length, totalBytes, largestMessageBytes },
		};
	}

	return {
		valid: true,
		details: { messageCount: messages.length, totalBytes, largestMessageBytes },
	};
}

// ============================================
// 3. Error Sanitization
// ============================================

const SENSITIVE_PATTERNS = [
	/request[_-]?id[:\s]*["']?[a-z0-9-]+["']?/gi,
	/x-request-id[:\s]*["']?[a-z0-9-]+["']?/gi,
	/trace[_-]?id[:\s]*["']?[a-z0-9-]+["']?/gi,
	/correlation[_-]?id[:\s]*["']?[a-z0-9-]+["']?/gi,
	/zhn_(?:live|test)_[a-zA-Z0-9]+/g,   // API keys
	/Bearer\s+[a-zA-Z0-9._-]+/gi,         // Bearer tokens
	/at\s+[\w./<>]+\s*\(.*:\d+:\d+\)/g,   // Stack trace lines
	/^\s+at\s+.+$/gm,                      // Stack traces
	/Error:\s*.*\n\s+at/g,                // Error stack beginnings
];

const ERROR_CODE_MAP: Record<string, string> = {
	RATE_LIMIT_EXCEEDED: 'Rate limit exceeded. Please wait before retrying.',
	UNAUTHORIZED: 'Authentication failed. Please check your API credentials.',
	INVALID_MODEL: 'The specified model is not available.',
	MODEL_REQUIRED: 'A model must be specified.',
	INTERNAL_ERROR: 'An internal error occurred. Please try again later.',
	TIMEOUT: 'Request timed out. Try reducing the prompt size or increasing timeout.',
	INVALID_REQUEST: 'The request was malformed. Please check your input.',
	INSUFFICIENT_CREDITS: 'Insufficient credits. Please check your account balance.',
	CONTEXT_LENGTH_EXCEEDED: 'The input exceeds the model context length limit.',
};

export interface SanitizedError {
	message: string;
	code?: string;
	retryable: boolean;
	retryAfter?: number;
}

/**
 * Sanitizes API errors to prevent information leakage
 * @param error - The error object to sanitize
 * @param options - Sanitization options
 * @returns Sanitized error with safe message
 */
export function sanitizeApiError(
	error: unknown,
	_options: { includeDetails?: boolean } = {},
): SanitizedError {
	let message = 'An unexpected error occurred';
	let code: string | undefined;
	let retryable = false;
	let retryAfter: number | undefined;

	if (typeof error === 'object' && error !== null) {
		const err = error as Record<string, unknown>;

		// Extract error code
		code = (err.error || err.code) as string | undefined;

		// Map known error codes to safe messages
		if (code && ERROR_CODE_MAP[code]) {
			message = ERROR_CODE_MAP[code];
		} else if (err.message && typeof err.message === 'string') {
			message = err.message;
		}

		// Check retryability
		if (code === 'RATE_LIMIT_EXCEEDED' || code === 'TIMEOUT') {
			retryable = true;
			retryAfter = (err.retryAfter as number) || 60;
		}

		// Sanitize the message
		for (const pattern of SENSITIVE_PATTERNS) {
			message = message.replace(pattern, '[REDACTED]');
		}
	} else if (typeof error === 'string') {
		message = error;
		for (const pattern of SENSITIVE_PATTERNS) {
			message = message.replace(pattern, '[REDACTED]');
		}
	}

	// Truncate very long messages
	if (message.length > 500) {
		message = message.substring(0, 500) + '...';
	}

	return { message, code, retryable, retryAfter };
}

// ============================================
// 4. API Key Validation
// ============================================

const API_KEY_PATTERN = /^zhn_(live|test)_[a-zA-Z0-9]{20,}$/;

export interface ApiKeyValidationResult {
	valid: boolean;
	error?: string;
	environment?: 'live' | 'test';
}

/**
 * Validates API key format
 * @param apiKey - The API key to validate
 * @returns Validation result with environment detection
 */
export function validateApiKeyFormat(apiKey: string): ApiKeyValidationResult {
	if (!apiKey || apiKey.trim() === '') {
		return { valid: false, error: 'API key is required' };
	}

	const trimmed = apiKey.trim();

	if (!API_KEY_PATTERN.test(trimmed)) {
		return {
			valid: false,
			error: 'Invalid API key format. Expected format: zhn_live_xxx or zhn_test_xxx',
		};
	}

	const environment = trimmed.startsWith('zhn_live_') ? 'live' : 'test';

	return { valid: true, environment };
}

// ============================================
// 5. HMAC Request Signing (Optional)
// ============================================

export interface SignedRequestHeaders {
	'X-Zihin-Signature': string;
	'X-Zihin-Timestamp': string;
	'X-Zihin-Nonce': string;
}

/**
 * Signs a request payload with HMAC-SHA256
 * @param payload - The request payload (JSON string)
 * @param secretKey - The signing secret key
 * @param timestamp - Optional timestamp (defaults to Date.now())
 * @returns Headers to include in the request
 */
export function signRequest(
	payload: string,
	secretKey: string,
	timestamp?: number,
): SignedRequestHeaders {
	const ts = timestamp || Date.now();
	const nonce = randomBytes(16).toString('hex');
	const message = `${ts}.${nonce}.${payload}`;

	const signature = createHmac('sha256', secretKey)
		.update(message)
		.digest('hex');

	return {
		'X-Zihin-Signature': `sha256=${signature}`,
		'X-Zihin-Timestamp': ts.toString(),
		'X-Zihin-Nonce': nonce,
	};
}

/**
 * Verifies a request timestamp is within acceptable age
 * @param timestamp - The request timestamp
 * @param maxAgeMs - Maximum age in milliseconds (default: 5 minutes)
 * @returns true if timestamp is within acceptable range
 */
export function verifyRequestAge(
	timestamp: number,
	maxAgeMs: number = 5 * 60 * 1000,
): boolean {
	const now = Date.now();
	const age = Math.abs(now - timestamp);
	return age <= maxAgeMs;
}

// ============================================
// 6. Telemetry Sanitization
// ============================================

export interface SanitizedTelemetry {
	call_source: string;
	session_id?: string;
}

export interface TelemetryContext {
	workflowId?: string;
	nodeName?: string;
	executionId?: string;
	sessionId?: string;
	nodeType?: 'gateway' | 'chat_model';
}

/**
 * Sanitizes telemetry data to protect privacy
 * @param context - The telemetry context
 * @param options - Sanitization options
 * @returns Sanitized telemetry data
 */
export function sanitizeTelemetryData(
	context: TelemetryContext,
	options: { includePII?: boolean } = {},
): SanitizedTelemetry {
	const parts = ['n8n'];
	const nodeType = context.nodeType || 'gateway';

	if (options.includePII && context.workflowId) {
		// Hash the workflow ID for privacy
		const hashedId = createHmac('sha256', 'zihin-telemetry-salt')
			.update(context.workflowId)
			.digest('hex')
			.substring(0, 8);
		parts.push(hashedId);
	}

	// Include node type indicator
	parts.push(nodeType);

	return {
		call_source: parts.join('.'),
		session_id: context.sessionId,
	};
}

// ============================================
// 7. Input Content Sanitization
// ============================================

/**
 * Sanitizes node name for safe use in telemetry
 * @param nodeName - The raw node name
 * @returns Sanitized node name
 */
export function sanitizeNodeName(nodeName: string): string {
	return nodeName
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.substring(0, 50);
}

// ============================================
// Export Default Limits for Reference
// ============================================

export { DEFAULT_LIMITS };
