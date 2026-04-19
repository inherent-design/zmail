export interface ParsedSseEvent {
	id?: string;
	event: string;
	data: string;
}

function parseSseBlock(block: string) {
	const lines = block
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);
	if (lines.length === 0) {
		return null;
	}

	let id: string | undefined;
	let event = "message";
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("id:")) {
			id = line.slice(3).trim();
			continue;
		}
		if (line.startsWith("event:")) {
			event = line.slice(6).trim() || "message";
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
		}
	}

	return {
		id,
		event,
		data: dataLines.join("\n"),
	} satisfies ParsedSseEvent;
}

export async function consumeSseResponse(
	response: Response,
	input: {
		onEvent: (event: ParsedSseEvent) => void | Promise<void>;
		signal?: AbortSignal;
	},
) {
	if (!response.ok) {
		throw new Error(`SSE request failed with ${response.status}`);
	}
	if (!response.body) {
		throw new Error("SSE response body is missing.");
	}

	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";

	while (true) {
		if (input.signal?.aborted) {
			return;
		}
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += value;
		let separatorIndex = buffer.search(/\r?\n\r?\n/);
		while (separatorIndex >= 0) {
			const block = buffer.slice(0, separatorIndex);
			buffer = buffer.slice(separatorIndex).replace(/^\r?\n\r?\n/, "");
			const event = parseSseBlock(block);
			if (event) {
				await input.onEvent(event);
			}
			separatorIndex = buffer.search(/\r?\n\r?\n/);
		}
	}
}

export async function openSseClient(input: {
	url: string;
	headers?: Record<string, string>;
	signal: AbortSignal;
	onEvent: (event: ParsedSseEvent) => void | Promise<void>;
}) {
	const response = await fetch(input.url, {
		headers: input.headers,
		signal: input.signal,
	});
	return consumeSseResponse(response, {
		onEvent: input.onEvent,
		signal: input.signal,
	});
}
