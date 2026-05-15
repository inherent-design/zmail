import {
	type ClientMutationEnvelope,
	parseClientMutationEnvelope,
} from "#/lib/client-contract";
import { goto } from "$app/navigation";
import { invalidateZmail } from "./invalidation";
import { useToasts } from "./toast-store.svelte";

export async function postMutation(
	url: string,
	body?: unknown,
): Promise<ClientMutationEnvelope> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-requested-with": "zmail-client",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		throw new Error(
			json && typeof json === "object" && "error" in json
				? String(json.error)
				: `Mutation failed with ${response.status}.`,
		);
	}
	const envelope = parseClientMutationEnvelope(json);
	useToasts().push(envelope.toast);
	if (envelope.invalidate?.length) {
		await invalidateZmail(envelope.invalidate);
	}
	if (envelope.redirectTo) {
		await goto(envelope.redirectTo);
	}
	return envelope;
}
