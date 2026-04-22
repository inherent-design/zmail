/** @jsxImportSource hono/jsx */

const sensitiveKeyPattern =
	/(authorization|cookie|oauth|password|refreshToken|accessToken|idToken|token|secret|rawRfc822|raw_rfc822|rfc822|accountNumber|account_number|routingNumber|routing_number)/i;

function redactSensitiveString(value: string) {
	return value.replace(/\b\d[\d -]{6,}\d\b/g, (match) => {
		if (/^\d{4}-\d{2}-\d{2}$/.test(match)) {
			return match;
		}
		const digitCount = match.replace(/\D/g, "").length;
		return digitCount >= 12 ? "[redacted-number]" : match;
	});
}

function redactJson(
	value: unknown,
	key = "",
	seen = new WeakSet<object>(),
): unknown {
	if (sensitiveKeyPattern.test(key)) {
		return "[redacted]";
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "string") {
		return redactSensitiveString(value);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return "[circular]";
		}
		seen.add(value);
		return value.map((item) => redactJson(item, "", seen));
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) {
			return "[circular]";
		}
		seen.add(value);
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(
				([entryKey, entryValue]) => [
					entryKey,
					redactJson(entryValue, entryKey, seen),
				],
			),
		);
	}
	return value;
}

function safeJson(value: unknown) {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return JSON.stringify(redactJson(value), null, 2) ?? "null";
	}
}

function jsonPath(parent: string, key: string | number) {
	if (typeof key === "number") {
		return `${parent}[${String(key)}]`;
	}
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
		? `${parent}.${key}`
		: `${parent}[${JSON.stringify(key)}]`;
}

function renderDataTree(
	value: unknown,
	path = "$",
	depth = 0,
	stateKey = "data-inspector",
): unknown {
	if (Array.isArray(value)) {
		return (
			<details
				class="data-inspector-node"
				data-json-path={path}
				data-zmail-state-key={`${stateKey}:tree:${path}`}
				open={depth < 1}
			>
				<summary>
					<code>{path}</code>
					<span>array[{String(value.length)}]</span>
					<button type="button" data-copy-path={path}>
						Copy path
					</button>
				</summary>
				<div class="data-inspector-children">
					{value.map((item, index) =>
						renderDataTree(item, jsonPath(path, index), depth + 1, stateKey),
					)}
				</div>
			</details>
		);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		return (
			<details
				class="data-inspector-node"
				data-json-path={path}
				data-zmail-state-key={`${stateKey}:tree:${path}`}
				open={depth < 1}
			>
				<summary>
					<code>{path}</code>
					<span>object[{String(entries.length)}]</span>
					<button type="button" data-copy-path={path}>
						Copy path
					</button>
				</summary>
				<div class="data-inspector-children">
					{entries.map(([entryKey, entryValue]) =>
						renderDataTree(
							entryValue,
							jsonPath(path, entryKey),
							depth + 1,
							stateKey,
						),
					)}
				</div>
			</details>
		);
	}
	return (
		<div class="data-inspector-leaf" data-json-path={path}>
			<code>{path}</code>
			<span>{value === null ? "null" : String(value)}</span>
			<button type="button" data-copy-path={path}>
				Copy path
			</button>
		</div>
	);
}

export function ActionButton(input: {
	label: string;
	action?: string;
	payload?: unknown;
	variant?: "primary" | "secondary";
}) {
	return (
		<button
			type="button"
			class={input.variant === "secondary" ? "button secondary" : "button"}
			data-rpc={input.action}
			data-payload={input.payload ? JSON.stringify(input.payload) : undefined}
		>
			{input.label}
		</button>
	);
}

export function IconButton(input: { label: string; title?: string }) {
	return (
		<button
			type="button"
			class="icon-button"
			title={input.title ?? input.label}
		>
			{input.label}
		</button>
	);
}

export function ButtonGroup(input: { children: unknown }) {
	return <div class="button-group">{input.children}</div>;
}

export function Field(input: { label: string; children: unknown }) {
	return (
		<div class="field">
			<span>{input.label}</span>
			{input.children}
		</div>
	);
}

export const SelectField = Field;
export const CheckboxField = Field;
export const SwitchField = Field;

export function InlineStatus(input: { children: unknown }) {
	return <span class="inline-status">{input.children}</span>;
}

export function ToastRegion() {
	return (
		<div class="toast-region" data-zmail-toast-region aria-live="polite" />
	);
}

export function ProgressBadge(input: { children: unknown }) {
	return <span class="progress-badge">{input.children}</span>;
}

export function EntityBadge(input: { children: unknown }) {
	return <span class="entity-badge">{input.children}</span>;
}

export function RelationshipPill(input: { children: unknown }) {
	return <span class="relationship-pill">{input.children}</span>;
}

export function ConfirmAction(input: { children: unknown }) {
	return <div class="confirm-action">{input.children}</div>;
}

export function DataInspector(input: {
	kind: string;
	id?: string | null;
	status?: string | null;
	confidence?: number | null;
	value: unknown;
	stateKey?: string;
}) {
	const stateKey = input.stateKey ?? `${input.kind}:${input.id ?? "unknown"}`;
	const safeValue = redactJson(input.value);
	return (
		<details class="data-inspector" data-zmail-state-key={stateKey}>
			<summary>
				<span>{input.kind}</span>
				{input.id ? <code>{input.id}</code> : null}
				{input.status ? <span>{input.status}</span> : null}
				{typeof input.confidence === "number" ? (
					<span>{Math.round(input.confidence * 100)}%</span>
				) : null}
			</summary>
			<div class="data-inspector-actions">
				<button type="button" data-copy-json>
					Copy JSON
				</button>
				<button type="button" data-copy-path="$">
					Copy root path
				</button>
				<span data-copy-status />
			</div>
			<div class="data-inspector-tree">
				{renderDataTree(safeValue, "$", 0, stateKey)}
			</div>
			<details
				class="data-inspector-raw"
				data-zmail-state-key={`${stateKey}:raw`}
			>
				<summary>Raw JSON</summary>
				<pre class="json-block" data-json-path="$">
					{safeJson(safeValue)}
				</pre>
			</details>
		</details>
	);
}

export function DecisionCard(input: { children: unknown }) {
	return <section class="decision-card">{input.children}</section>;
}

export function DecisionDeck(input: { children: unknown }) {
	return <div class="decision-deck">{input.children}</div>;
}

export function TransactionEditor(input: { children: unknown }) {
	return <div class="transaction-editor">{input.children}</div>;
}

export function WorkflowTable(input: { children: unknown }) {
	return <div class="workflow-table">{input.children}</div>;
}

export function WorkflowList(input: { children: unknown }) {
	return <div class="workflow-list">{input.children}</div>;
}
