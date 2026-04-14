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

export function buildAuthUrl(label: string) {
	const state = base64url(randomBytes(16));
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);

	const params = new URLSearchParams({
		client_id: GOOGLE_OAUTH.clientId,
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
		JSON.stringify({ state, codeVerifier, label }),
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
	const raw = JSON.parse(readFileSync(path, "utf8")) as {
		state: string;
		codeVerifier: string;
		label: string;
	};
	unlinkSync(path);
	return raw;
}

export async function exchangeCode(code: string, codeVerifier: string) {
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: GOOGLE_OAUTH.clientId,
			client_secret: GOOGLE_OAUTH.clientSecret,
			code,
			code_verifier: codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: GOOGLE_OAUTH.redirectUrl,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token exchange failed: ${response.status} ${text}`);
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
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: GOOGLE_OAUTH.clientId,
			client_secret: GOOGLE_OAUTH.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
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
		return null;
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
