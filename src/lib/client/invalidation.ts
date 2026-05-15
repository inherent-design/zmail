import type { ZmailInvalidationKey } from "#/lib/client-contract";
import { invalidate } from "$app/navigation";

export async function invalidateZmail(
	keys: readonly ZmailInvalidationKey[] = [],
) {
	await Promise.all(keys.map((key) => invalidate(key)));
}
