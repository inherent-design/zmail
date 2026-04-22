import { renderToast } from "./toasts.js";

function splitFieldList(value) {
	return (value ?? "")
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);
}

function readJson(value, fallback) {
	if (!value) {
		return fallback;
	}
	return JSON.parse(value);
}

function nearestErrorNode(element) {
	return (
		element
			.closest("[data-mutation-root]")
			?.querySelector("[data-mutation-error]") ??
		element.closest("form")?.querySelector("[data-mutation-error]") ??
		element
			.closest("[data-zmail-island]")
			?.querySelector("[data-mutation-error]") ??
		null
	);
}

function submitterFor(target, options) {
	return (
		options.submitter ??
		(target instanceof HTMLFormElement
			? target.querySelector('button[type="submit"],button:not([type])')
			: target)
	);
}

export function parseJsonForm(form) {
	const formData = new FormData(form);
	const jsonFields = new Set(splitFieldList(form.dataset.jsonFields));
	const numberFields = new Set(splitFieldList(form.dataset.numberFields));
	const checkboxFields = new Set(splitFieldList(form.dataset.checkboxFields));
	const nullEmptyFields = new Set(splitFieldList(form.dataset.nullEmpty));
	const payload = {};
	for (const [key, value] of formData.entries()) {
		if (value instanceof File) {
			continue;
		}
		if (value === "" && nullEmptyFields.has(key)) {
			payload[key] = null;
		} else if (jsonFields.has(key)) {
			payload[key] = JSON.parse(String(value || "null"));
		} else if (numberFields.has(key)) {
			payload[key] = value === "" ? null : Number(value);
		} else if (checkboxFields.has(key)) {
			payload[key] = value === "on" || value === "true";
		} else {
			payload[key] = value;
		}
	}
	for (const key of checkboxFields) {
		if (!formData.has(key)) {
			payload[key] = false;
		}
	}
	return payload;
}

export function partitionTargets(targets = []) {
	const normalized = [];
	const seen = new Set();
	for (const target of Array.isArray(targets) ? targets : []) {
		if (!target || typeof target !== "object") {
			continue;
		}
		let key = "";
		if (target.type === "redirect") {
			key = `redirect:${target.url}:${target.replace ? "1" : "0"}`;
		} else if (target.type === "main") {
			key = "main";
		} else if (target.type === "island") {
			key = `island:${target.id}`;
		} else if (target.type === "node") {
			key = `node:${target.islandId}:${target.nodeId}:${target.key}`;
		} else {
			continue;
		}
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		normalized.push(target);
	}
	const order = { redirect: 0, main: 1, island: 2, node: 3 };
	normalized.sort((left, right) => order[left.type] - order[right.type]);
	const islands = normalized.filter((target) => target.type === "island");
	const coveredIslandIds = new Set(islands.map((target) => target.id));
	return {
		redirects: normalized.filter((target) => target.type === "redirect"),
		main: normalized.filter((target) => target.type === "main"),
		islands,
		nodes: normalized.filter(
			(target) =>
				target.type === "node" && !coveredIslandIds.has(target.islandId),
		),
	};
}

export function planRefreshTargets(targets, fallbackTargets = []) {
	const effectiveTargets =
		Array.isArray(targets) && targets.length > 0 ? targets : fallbackTargets;
	return partitionTargets(effectiveTargets);
}

export function createMutationRuntime(input) {
	const { app, documentRef = document, fetchImpl = fetch } = input;

	function clearError(target) {
		const errorNode = nearestErrorNode(target);
		if (errorNode) {
			errorNode.textContent = "";
		}
	}

	function showError(target, error) {
		const errorNode = nearestErrorNode(target);
		const message = error instanceof Error ? error.message : String(error);
		if (errorNode) {
			errorNode.textContent = message;
		} else {
			documentRef.defaultView?.console?.error?.(message);
		}
	}

	async function request(target, options) {
		if (target instanceof HTMLFormElement) {
			if (target.dataset.mutation === "multipart") {
				const response = await fetchImpl(target.action, {
					method: target.method || "POST",
					body: new FormData(target),
					headers: { "x-requested-with": "zmail-client" },
				});
				const payload = await response.json().catch(() => ({
					ok: false,
					error: "invalid_response",
				}));
				if (!response.ok || !payload.ok) {
					throw new Error(payload.message || payload.error || "Request failed");
				}
				return payload;
			}
			return app.postJson(target.dataset.rpc, parseJsonForm(target));
		}
		if (options.payload !== undefined) {
			return app.postJson(target.dataset.rpc, options.payload);
		}
		return app.postJson(
			target.dataset.rpc,
			readJson(target.dataset.payload, {}),
		);
	}

	async function applyResult(result, options) {
		if (result?.ui?.toast) {
			renderToast(result.ui.toast, documentRef);
		}
		const targets = planRefreshTargets(
			result?.ui?.targets,
			options.fallbackTargets,
		);
		for (const redirect of targets.redirects) {
			await app.navigate(redirect.url, { replace: Boolean(redirect.replace) });
			return true;
		}
		if (targets.main.length > 0) {
			await app.refresh({ fallback: "main", source: "action" });
			return true;
		}
		if (targets.islands.length > 0 || targets.nodes.length > 0) {
			await app.refresh({
				islands: targets.islands.map((target) => target.id),
				nodes: targets.nodes,
				fallback: options.fallback ?? "none",
				source: "action",
			});
			return true;
		}
		return false;
	}

	async function mutate(target, options = {}) {
		const control = submitterFor(target, options);
		const wasDisabled = Boolean(control?.disabled);
		clearError(target);
		if (control) {
			control.disabled = true;
			control.setAttribute("data-zmail-preserve-pending", "true");
		}
		try {
			const result = await request(target, options);
			const replaced = await applyResult(result, options);
			if (target instanceof HTMLFormElement && options.resetOnSuccess) {
				target.reset();
			}
			if (!replaced && control) {
				control.disabled = wasDisabled;
				control.removeAttribute("data-zmail-preserve-pending");
			}
			return result;
		} catch (error) {
			showError(target, error);
			if (control) {
				control.disabled = wasDisabled;
				control.removeAttribute("data-zmail-preserve-pending");
			}
			throw error;
		}
	}

	function bind(root, optionsForTarget = () => ({})) {
		const onClick = (event) => {
			const button = event.target.closest("button[data-rpc]");
			if (!button || !root.contains(button)) {
				return;
			}
			event.preventDefault();
			void mutate(button, optionsForTarget(button, event)).catch(() => {});
		};
		const onSubmit = (event) => {
			const form = event.target.closest(
				"form[data-rpc],form[data-mutation='multipart']",
			);
			if (!form || !root.contains(form)) {
				return;
			}
			event.preventDefault();
			void mutate(form, {
				...optionsForTarget(form, event),
				submitter: event.submitter,
			}).catch(() => {});
		};
		root.addEventListener("click", onClick);
		root.addEventListener("submit", onSubmit);
		return () => {
			root.removeEventListener("click", onClick);
			root.removeEventListener("submit", onSubmit);
		};
	}

	return {
		bind,
		mutate,
		parseJsonForm,
		planRefreshTargets,
	};
}
