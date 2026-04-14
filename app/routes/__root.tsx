import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Link,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import appCss from "#/app/styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "zmail",
			},
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	component: RootComponent,
});

export function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<TanStackDevtools
					config={{ position: "bottom-right" }}
					plugins={[
						{
							name: "Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}

export function RootLayout() {
	return (
		<div className="shell">
			<header className="topbar">
				<div className="brand">zmail</div>
				<nav className="nav">
					<Link to="/accounts">Accounts</Link>
					<Link to="/">Home</Link>
					<Link to="/messages">Messages</Link>
					<Link to="/review">Review</Link>
					<Link to="/runs">Runs</Link>
				</nav>
			</header>
			<main className="page">
				<Outlet />
			</main>
		</div>
	);
}

export function RootComponent() {
	return (
		<RootDocument>
			<RootLayout />
		</RootDocument>
	);
}
