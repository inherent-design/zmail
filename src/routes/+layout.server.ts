import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		principal: locals.principal,
		orgId: locals.orgId,
		role: locals.role,
	};
};
