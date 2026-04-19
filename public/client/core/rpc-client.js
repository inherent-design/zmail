export function createRpcClient(fetchImpl = fetch) {
	async function postJson(path, body) {
		const response = await fetchImpl(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-requested-with": "zmail-client",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = await response.json().catch(() => ({
			ok: false,
			error: "invalid_response",
		}));
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || payload.error || "Request failed");
		}
		return payload;
	}

	return {
		postJson,
	};
}
