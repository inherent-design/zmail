import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/accounts/$accountId")({
	component: () => <Outlet />,
});
