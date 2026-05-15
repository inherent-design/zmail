import type { BrowserPrincipal, OrgRole } from "#/server/auth";

declare global {
	namespace App {
		interface Locals {
			principal: BrowserPrincipal | null;
			orgId: string | null;
			role: OrgRole | null;
		}
	}
}
