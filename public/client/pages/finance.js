import { getChart, initChart } from "../core/charting.js";

const ANALYTICS_ISLANDS = [
	"finance.summary",
	"finance.cashflow",
	"finance.categories",
	"finance.subscriptions",
	"finance.ledger-preview",
	"finance.export-health",
];

const STATUS_ISLANDS = ["finance.command-bar", "finance.export-health"];

function financeIslandHints(event) {
	const hinted = event.payload?.changeHints?.islands;
	if (Array.isArray(hinted)) {
		const financeHints = hinted
			.map((value) => String(value))
			.filter((value) => value.startsWith("finance."));
		if (financeHints.length > 0) {
			return financeHints;
		}
	}
	switch (event.eventType) {
		case "finance.ledger_rebuilt":
		case "finance.patterns_rebuilt":
			return ANALYTICS_ISLANDS;
		case "finance.export_started":
		case "finance.export_completed":
		case "finance.export_failed":
			return STATUS_ISLANDS;
		default:
			return ["finance.command-bar"];
	}
}

function actionRefreshIslands(target) {
	const island = target.closest("[data-zmail-island]")?.dataset.zmailIsland;
	if (island === "finance.export-health") {
		return STATUS_ISLANDS;
	}
	return ["finance.command-bar", ...ANALYTICS_ISLANDS];
}

function parseFormPayload(form) {
	const formData = new FormData(form);
	const payload = {};
	for (const [key, value] of formData.entries()) {
		if (value === "") {
			payload[key] = null;
		} else if (key === "year") {
			payload[key] = Number(value);
		} else if (key === "strict") {
			payload[key] = value === "on" || value === "true";
		} else {
			payload[key] = value;
		}
	}
	if (!formData.has("strict")) {
		payload.strict = false;
	}
	return payload;
}

function readChartProps(root) {
	const id = root.dataset.zmailIsland;
	const script = id
		? root.querySelector(`[data-zmail-island-props="${id}"]`)
		: null;
	if (!script?.textContent) {
		return null;
	}
	try {
		return JSON.parse(script.textContent);
	} catch {
		return null;
	}
}

function restoreChartState(chart, state) {
	if (!state || typeof state !== "object") {
		return;
	}
	const option = {};
	if (Array.isArray(state.dataZoom)) {
		option.dataZoom = state.dataZoom;
	}
	if (state.legendSelected && typeof state.legendSelected === "object") {
		option.legend = [{ selected: state.legendSelected }];
	}
	if (Object.keys(option).length > 0) {
		chart.setOption(option);
	}
}

function captureChartState(root) {
	const element = root.querySelector("[data-finance-chart]");
	const chart = element ? getChart(element) : null;
	const option = chart?.getOption?.();
	return {
		dataZoom: option?.dataZoom ?? null,
		legendSelected: option?.legend?.[0]?.selected ?? null,
	};
}

function cashflowOption(props) {
	const series = Array.isArray(props?.series) ? props.series : [];
	return {
		animation: false,
		tooltip: { trigger: "axis" },
		legend: { top: 0 },
		grid: { left: 56, right: 20, top: 44, bottom: 48 },
		xAxis: {
			type: "category",
			data: series.map((point) => point.month),
		},
		yAxis: {
			type: "value",
			axisLabel: { formatter: (value) => `$${Math.round(value / 100)}` },
		},
		dataZoom: [{ type: "inside" }, { type: "slider", height: 18 }],
		series: [
			{
				name: "Inflow",
				type: "bar",
				stack: "cashflow",
				data: series.map((point) => point.inflowMinor),
			},
			{
				name: "Outflow",
				type: "bar",
				stack: "cashflow",
				data: series.map((point) => -point.outflowMinor),
			},
			{
				name: "Net",
				type: "line",
				smooth: true,
				data: series.map((point) => point.netMinor),
			},
		],
	};
}

function categoriesOption(props) {
	const categories = Array.isArray(props?.categories) ? props.categories : [];
	return {
		animation: false,
		tooltip: { trigger: "axis" },
		legend: { top: 0 },
		grid: { left: 112, right: 20, top: 44, bottom: 28 },
		xAxis: {
			type: "value",
			axisLabel: { formatter: (value) => `$${Math.round(value / 100)}` },
		},
		yAxis: {
			type: "category",
			data: categories.map((row) =>
				row.secondaryCategory
					? `${row.primaryCategory} / ${row.secondaryCategory}`
					: row.primaryCategory,
			),
		},
		series: [
			{
				name: "Outflow",
				type: "bar",
				data: categories.map((row) => row.outflowMinor),
			},
			{
				name: "Inflow",
				type: "bar",
				data: categories.map((row) => row.inflowMinor),
			},
		],
	};
}

function chartIsland(id, optionBuilder) {
	let cleanup = null;
	return {
		init(ctx) {
			const element = ctx.root.querySelector("[data-finance-chart]");
			if (!element) {
				return null;
			}
			cleanup?.();
			const props = readChartProps(ctx.root) ?? ctx.props;
			const mounted = initChart(element, optionBuilder(props));
			restoreChartState(mounted.chart, ctx.state);
			cleanup = mounted.dispose;
			return () => {
				cleanup?.();
				cleanup = null;
			};
		},
		beforeSwap() {
			const root = document.querySelector(`[data-zmail-island="${id}"]`);
			return root ? captureChartState(root) : null;
		},
	};
}

export const islands = {
	"finance.cashflow": chartIsland("finance.cashflow", cashflowOption),
	"finance.categories": chartIsland("finance.categories", categoriesOption),
};

export function init(app) {
	const root = document.getElementById("app-main");
	if (!root || root.dataset.page !== "finance") {
		return null;
	}
	const onClick = async (event) => {
		const button = event.target.closest("button[data-rpc]");
		if (!button || !root.contains(button)) {
			return;
		}
		button.disabled = true;
		try {
			await app.postJson(button.dataset.rpc, {});
			await app.refresh({ islands: actionRefreshIslands(button) });
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};
	root.addEventListener("click", onClick);
	const onSubmit = async (event) => {
		const form = event.target.closest("form[data-rpc]");
		if (!form || !root.contains(form)) {
			return;
		}
		event.preventDefault();
		const submit = form.querySelector('button[type="submit"]');
		if (submit) {
			submit.disabled = true;
		}
		try {
			await app.postJson(form.dataset.rpc, parseFormPayload(form));
			await app.refresh({ islands: STATUS_ISLANDS });
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			if (submit) {
				submit.disabled = false;
			}
		}
	};
	root.addEventListener("submit", onSubmit);
	const isTerminalJob = (event) =>
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" ||
			event.payload?.status === "failed");
	const isFinanceJob = (event) => {
		const kind = String(event.payload?.kind ?? "");
		const scopeId = String(event.payload?.scopeId ?? "");
		return (
			kind.includes("finance") ||
			kind.includes("registry") ||
			scopeId === "finance" ||
			scopeId === "registry_suggestions"
		);
	};
	const onFinance = (event) =>
		void app.scheduleRefresh({
			islands: financeIslandHints(event),
			immediate: true,
		});
	const onJobs = (event) => {
		if (!isFinanceJob(event)) {
			return;
		}
		void app.scheduleRefresh({
			islands: STATUS_ISLANDS,
			immediate: isTerminalJob(event),
		});
	};
	const unsubscribers = [
		app.subscribe("finance", onFinance),
		app.subscribe("jobs", onJobs),
	];
	return () => {
		root.removeEventListener("click", onClick);
		root.removeEventListener("submit", onSubmit);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
