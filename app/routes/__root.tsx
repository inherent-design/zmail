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
	errorComponent: ({ error }) => (
		<RootDocument>
			<RootErrorComponent
				error={error instanceof Error ? error : new Error(String(error))}
			/>
		</RootDocument>
	),
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
					<Link to="/finance">Finance</Link>
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

function RootErrorComponent({ error }: { error: Error }) {
	if (error.name === "SchemaResetRequiredError") {
		return (
			<div className="shell">
				<main className="page">
					<section className="card stack">
						<h1>Local DB reset required</h1>
						<p className="muted">{error.message}</p>
						<div className="stack">
							<p className="muted">Preferred recovery</p>
							<ol className="stack">
								<li>
									<code>pnpm db:reset:messages</code>
								</li>
							</ol>
							<p className="muted">Full reset</p>
							<ol className="stack">
								<li>
									<code>pnpm db:reset</code>
								</li>
								<li>
									<code>pnpm db:migrate</code>
								</li>
								<li>Reconnect Gmail accounts if you used the full reset.</li>
							</ol>
						</div>
					</section>
				</main>
			</div>
		);
	}

	return (
		<div className="shell">
			<main className="page">
				<section className="card stack">
					<h1>Application error</h1>
					<p className="muted">
						{error.message ||
							"The application could not complete this request."}
					</p>
				</section>
			</main>
		</div>
	);
}
