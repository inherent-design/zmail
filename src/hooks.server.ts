import { type Handle, redirect } from "@sveltejs/kit";

import { appPath, stripBasePath } from "#/lib/app-config";
import { orgNeedsLegacyClaim, runWithOrgContext } from "#/lib/runtime";
import {
	isClaimLegacyPath,
	isOrgSelectionPath,
	resolveBrowserPrincipalFromRequest,
	safeReturnTo,
} from "#/server/auth";

function currentPath(request: Request) {
	const url = new URL(request.url);
	return `${url.pathname}${url.search}`;
}

export const handle: Handle = async ({ event, resolve }) => {
	const resolved = await resolveBrowserPrincipalFromRequest(event.request);
	if (!resolved.ok) {
		throw redirect(
			303,
			appPath(
				`/auth/login?returnTo=${encodeURIComponent(currentPath(event.request))}`,
			),
		);
	}

	const pathname = stripBasePath(event.url.pathname);
	event.locals.principal = resolved.principal;
	event.locals.orgId = resolved.principal.orgId;
	event.locals.role = resolved.principal.role;

	if (!resolved.principal.orgId) {
		if (!isOrgSelectionPath(pathname)) {
			throw redirect(
				303,
				appPath(
					`/org/select?returnTo=${encodeURIComponent(currentPath(event.request))}`,
				),
			);
		}
		return resolve(event);
	}

	if (
		resolved.principal.role === "org_admin" &&
		orgNeedsLegacyClaim(resolved.principal.orgId) &&
		!isClaimLegacyPath(pathname)
	) {
		throw redirect(
			303,
			appPath(
				`/org/claim-legacy?returnTo=${encodeURIComponent(
					safeReturnTo(currentPath(event.request)),
				)}`,
			),
		);
	}

	return runWithOrgContext(resolved.principal.orgId, () => resolve(event));
};
