import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
	accountOAuthPath,
	GOOGLE_OAUTH,
	nowIso,
	OAUTH_TMP_DIR,
} from "#/lib/config";
import { startTrace } from "#/lib/log";
import type { GoogleOAuthRecord } from "#/lib/schemas";
import { googleOAuthRecordSchema } from "#/lib/schemas";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_STATE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

interface GoogleOAuthStateRecord {
	state: string;
	codeVerifier: string;
	label: string;
	flow?: "connect" | "reconnect";
	accountId?: string;
	ownerPrincipalEmail?: string;
}

interface GoogleOAuthErrorPayload {
	error?: string;
	error_description?: string;
}

export const GOOGLE_OAUTH_BOOTSTRAP_ERROR_PREFIX =
	"Google OAuth client credentials were rejected by Google.";

export class GoogleOAuthBootstrapError extends Error {
	statusCode: number | null;
	providerError: string | null;
	providerErrorDescription: string | null;

	constructor(
		message: string,
		input?: Partial<{
			statusCode: number | null;
			providerError: string | null;
			providerErrorDescription: string | null;
		}>,
	) {
		super(message);
		this.name = "GoogleOAuthBootstrapError";
		this.statusCode = input?.statusCode ?? null;
		this.providerError = input?.providerError ?? null;
		this.providerErrorDescription = input?.providerErrorDescription ?? null;
	}
}

export class GoogleOAuthProviderError extends Error {
	statusCode: number;
	providerError: string | null;
	providerErrorDescription: string | null;
	retryable: boolean;

	constructor(
		message: string,
		input: {
			statusCode: number;
			providerError?: string | null;
			providerErrorDescription?: string | null;
			retryable?: boolean;
		},
	) {
		super(message);
		this.name = "GoogleOAuthProviderError";
		this.statusCode = input.statusCode;
		this.providerError = input.providerError ?? null;
		this.providerErrorDescription = input.providerErrorDescription ?? null;
		this.retryable = input.retryable ?? false;
	}
}

function googleOAuthBootstrapRejectedMessage() {
	return `${GOOGLE_OAUTH_BOOTSTRAP_ERROR_PREFIX} Verify GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for redirect URL ${GOOGLE_OAUTH.redirectUrl}. Start local server with mise run dev.`;
}

export function isGoogleOAuthBootstrapErrorMessage(
	message: string | null | undefined,
) {
	return (
		typeof message === "string" &&
		message.includes(GOOGLE_OAUTH_BOOTSTRAP_ERROR_PREFIX)
	);
}

function requireGoogleOAuthEnv(
	name: "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET",
) {
	const value =
		name === "GOOGLE_OAUTH_CLIENT_ID"
			? GOOGLE_OAUTH.clientId
			: GOOGLE_OAUTH.clientSecret;
	if (!value) {
		throw new GoogleOAuthBootstrapError(
			`Missing required Google OAuth bootstrap env: ${name}. Run the server through mise so secrets.enc.yaml is loaded, or provide the variable through deployment runtime env.`,
		);
	}
	return value;
}

export function assertGoogleOAuthBootstrapEnv() {
	requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_ID");
	requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_SECRET");
}

export function isOAuthConfigured() {
	return Boolean(GOOGLE_OAUTH.clientId && GOOGLE_OAUTH.clientSecret);
}

export function missingOAuthVars() {
	const missing: string[] = [];
	if (!GOOGLE_OAUTH.clientId) {
		missing.push("GOOGLE_OAUTH_CLIENT_ID");
	}
	if (!GOOGLE_OAUTH.clientSecret) {
		missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
	}
	return missing;
}

function base64url(buffer: Buffer) {
	return buffer.toString("base64url");
}

function generateCodeVerifier() {
	return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string) {
	return base64url(createHash("sha256").update(verifier).digest());
}

async function readGoogleOAuthErrorPayload(response: Response) {
	const text = await response.text();
	if (!text) {
		return {
			providerError: null,
			providerErrorDescription: null,
		};
	}
	try {
		const payload = JSON.parse(text) as GoogleOAuthErrorPayload;
		return {
			providerError: typeof payload.error === "string" ? payload.error : null,
			providerErrorDescription:
				typeof payload.error_description === "string"
					? payload.error_description
					: null,
		};
	} catch {
		return {
			providerError: null,
			providerErrorDescription: null,
		};
	}
}

function buildGoogleOAuthEndpointError(
	operation: "exchange" | "refresh",
	input: {
		statusCode: number;
		providerError: string | null;
		providerErrorDescription: string | null;
	},
) {
	if (input.providerError === "invalid_client") {
		return new GoogleOAuthBootstrapError(
			googleOAuthBootstrapRejectedMessage(),
			{
				statusCode: input.statusCode,
				providerError: input.providerError,
				providerErrorDescription: input.providerErrorDescription,
			},
		);
	}

	const messagePrefix =
		operation === "exchange"
			? "Google OAuth token exchange failed."
			: "Google OAuth token refresh failed.";
	let message = messagePrefix;
	if (input.providerError === "invalid_grant") {
		message = `${messagePrefix} Google returned invalid_grant.`;
	} else if (input.providerError) {
		message = `${messagePrefix} Google returned ${input.providerError}.`;
	} else {
		message = `${messagePrefix} Google returned HTTP ${input.statusCode}.`;
	}
	return new GoogleOAuthProviderError(message, {
		statusCode: input.statusCode,
		providerError: input.providerError,
		providerErrorDescription: input.providerErrorDescription,
		retryable: input.statusCode === 429 || input.statusCode >= 500,
	});
}

export function buildAuthUrl(
	input:
		| string
		| {
				label: string;
				flow?: "connect" | "reconnect";
				accountId?: string;
				ownerPrincipalEmail?: string;
		  },
) {
	const normalizedInput =
		typeof input === "string"
			? {
					label: input,
					flow: "connect" as const,
				}
			: {
					label: input.label,
					flow: input.flow ?? "connect",
					accountId: input.accountId,
					ownerPrincipalEmail: input.ownerPrincipalEmail,
				};
	assertGoogleOAuthBootstrapEnv();
	const state = base64url(randomBytes(16));
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);

	const params = new URLSearchParams({
		client_id: requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_ID"),
		redirect_uri: GOOGLE_OAUTH.redirectUrl,
		response_type: "code",
		scope: GOOGLE_OAUTH.scope,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});

	mkdirSync(OAUTH_TMP_DIR, { recursive: true });
	writeFileSync(
		resolve(OAUTH_TMP_DIR, `${state}.json`),
		JSON.stringify({
			state,
			codeVerifier,
			label: normalizedInput.label,
			flow: normalizedInput.flow,
			accountId: normalizedInput.accountId,
			ownerPrincipalEmail: normalizedInput.ownerPrincipalEmail,
		} satisfies GoogleOAuthStateRecord),
	);

	return {
		url: `${AUTH_ENDPOINT}?${params.toString()}`,
		state,
	};
}

export function loadOAuthState(state: string) {
	if (!OAUTH_STATE_TOKEN_RE.test(state)) {
		return null;
	}

	const path = resolve(OAUTH_TMP_DIR, `${state}.json`);
	if (!existsSync(path)) {
		return null;
	}
	const raw = JSON.parse(readFileSync(path, "utf8")) as GoogleOAuthStateRecord;
	unlinkSync(path);
	return raw;
}

export async function exchangeCode(code: string, codeVerifier: string) {
	assertGoogleOAuthBootstrapEnv();
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_ID"),
			client_secret: requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
			code,
			code_verifier: codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: GOOGLE_OAUTH.redirectUrl,
		}),
	});

	if (!response.ok) {
		throw buildGoogleOAuthEndpointError("exchange", {
			statusCode: response.status,
			...(await readGoogleOAuthErrorPayload(response)),
		});
	}

	return (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		token_type: string;
		scope: string;
	};
}

export async function refreshAccessToken(refreshToken: string) {
	assertGoogleOAuthBootstrapEnv();
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_ID"),
			client_secret: requireGoogleOAuthEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		throw buildGoogleOAuthEndpointError("refresh", {
			statusCode: response.status,
			...(await readGoogleOAuthErrorPayload(response)),
		});
	}

	return (await response.json()) as {
		access_token: string;
		expires_in: number;
		token_type: string;
		scope: string;
	};
}

export async function fetchEmailIdentity(accessToken: string) {
	const response = await fetch(USERINFO_ENDPOINT, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		throw new Error(`Userinfo fetch failed: ${response.status}`);
	}

	const info = (await response.json()) as { email: string };
	return info.email;
}

export function writeOAuthToken(accountId: string, record: GoogleOAuthRecord) {
	const path = accountOAuthPath(accountId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function readOAuthToken(accountId: string): GoogleOAuthRecord | null {
	const path = accountOAuthPath(accountId);
	if (!existsSync(path)) {
		return null;
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return googleOAuthRecordSchema.parse(raw);
	} catch {
		return null;
	}
}

export function deleteOAuthToken(accountId: string) {
	const path = accountOAuthPath(accountId);
	if (existsSync(path)) {
		unlinkSync(path);
	}
}

export async function ensureFreshToken(
	accountId: string,
): Promise<GoogleOAuthRecord | null> {
	const trace = startTrace({
		kind: "oauth",
		operation: "ensure_fresh_token",
		account_id: accountId,
	});
	const token = readOAuthToken(accountId);
	if (!token) {
		trace.info("oauth.token_missing", {
			outcome: "missing_token",
		});
		return null;
	}

	const expiresAt = new Date(token.expiresAt).getTime();
	const bufferMs = 60_000;
	if (Date.now() < expiresAt - bufferMs) {
		return token;
	}

	try {
		const refreshed = await refreshAccessToken(token.refreshToken);
		const updated: GoogleOAuthRecord = {
			...token,
			accessToken: refreshed.access_token,
			expiresAt: new Date(
				Date.now() + refreshed.expires_in * 1000,
			).toISOString(),
			tokenType: refreshed.token_type,
			updatedAt: nowIso(),
		};
		writeOAuthToken(accountId, updated);
		trace.complete("oauth.refresh.complete");
		return updated;
	} catch (error) {
		trace.fail("oauth.refresh.failed", error);
		if (
			error instanceof GoogleOAuthProviderError &&
			error.providerError === "invalid_grant"
		) {
			return null;
		}
		throw error;
	}
}

export function buildOAuthRecord(
	email: string,
	tokens: {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		token_type: string;
		scope: string;
	},
): GoogleOAuthRecord {
	return {
		version: 1,
		provider: "google",
		emailAddress: email,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
		scope: tokens.scope.split(" "),
		tokenType: tokens.token_type,
		updatedAt: nowIso(),
	};
}
