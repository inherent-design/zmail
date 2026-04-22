import { getChart, initChart } from "../core/charting.js";

const FINANCE_JOB_LANES = new Set([
	"finance_llm",
	"review_llm",
	"materialize",
	"export_report",
	"overseer",
]);

const STATUS_ISLANDS = ["finance.command-bar", "finance.lanes"];

function unique(values) {
	return Array.from(new Set(values.filter(Boolean)));
}

export function activeFinanceTabIsland(tab = currentFinanceTab()) {
	switch (tab) {
		case "readiness":
			return "finance.readiness";
		case "ledger":
			return "finance.ledger";
		case "imports":
			return "finance.imports";
		case "mappings":
			return "finance.mappings";
		case "review":
			return "finance.review";
		case "tax":
			return "finance.tax";
		case "exports":
			return "finance.export-health";
		default:
			return "finance.overview.rollups";
	}
}

function currentFinanceTab() {
	return new URLSearchParams(window.location.search).get("tab") ?? "overview";
}

function shouldRefreshAnalytics(event) {
	return (
		event.topic === "finance" &&
		(event.eventType === "finance.ledger_rebuilt" ||
			event.eventType === "finance.patterns_rebuilt")
	);
}

export function financeIslandHints(event, tab = currentFinanceTab()) {
	const hinted = event.payload?.changeHints?.islands;
	if (Array.isArray(hinted)) {
		const financeHints = hinted
			.map((value) => String(value))
			.filter((value) => value.startsWith("finance."));
		if (financeHints.length > 0) {
			return unique(
				financeHints.filter((id) => {
					if (
						id === "finance.review" ||
						id === "finance.readiness" ||
						id === "finance.ledger" ||
						id === "finance.imports" ||
						id === "finance.mappings" ||
						id === "finance.tax" ||
						id === "finance.overview.rollups"
					) {
						return id === activeFinanceTabIsland(tab);
					}
					return true;
				}),
			);
		}
	}
	switch (event.eventType) {
		case "finance.ledger_rebuilt":
			return unique([
				"finance.summary",
				"finance.cashflow",
				"finance.categories",
				activeFinanceTabIsland(tab),
				"finance.lanes",
			]);
		case "finance.patterns_rebuilt":
			return ["finance.subscriptions", "finance.summary", "finance.lanes"];
		case "finance.export_started":
		case "finance.export_completed":
		case "finance.export_failed":
		case "finance.tax_report_completed":
			return unique([
				"finance.export-health",
				tab === "tax" ? "finance.tax" : null,
				"finance.lanes",
			]);
		case "review_classifier.completed":
			return unique([
				tab === "review" ? "finance.review" : null,
				tab === "readiness" ? "finance.readiness" : null,
				"finance.lanes",
			]);
		default:
			return STATUS_ISLANDS;
	}
}

export function actionRefreshIslands(target, tab = currentFinanceTab()) {
	const island = target.closest("[data-zmail-island]")?.dataset.zmailIsland;
	const rpc =
		target.dataset.rpc ?? target.closest("form[data-rpc]")?.dataset.rpc ?? "";
	if (rpc.includes("/finance/mappings/upsert")) {
		return ["finance.mappings", "finance.readiness", "finance.lanes"];
	}
	if (
		rpc.includes("/finance/mappings/generate") ||
		rpc.includes("/finance/mappings/suggestions/")
	) {
		return ["finance.mappings", "finance.readiness", "finance.lanes"];
	}
	if (rpc.includes("/finance/tax/")) {
		return ["finance.tax", "finance.lanes"];
	}
	if (rpc.includes("/finance/export")) {
		return ["finance.export-health", "finance.lanes"];
	}
	if (island === "finance.export-health") {
		return ["finance.export-health", "finance.lanes"];
	}
	return unique([
		"finance.command-bar",
		"finance.lanes",
		activeFinanceTabIsland(tab),
	]);
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
		shouldRefresh: shouldRefreshAnalytics,
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
	const cleanupMutations = app.bindMutations(root, (target) => ({
		fallbackTargets: actionRefreshIslands(target).map((id) => ({
			type: "island",
			id,
		})),
		fallback: "none",
		resetOnSuccess: target.dataset.mutation === "multipart",
	}));
	const isTerminalJob = (event) =>
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" ||
			event.payload?.status === "failed");
	const isFinanceJob = (event) => {
		const kind = String(event.payload?.kind ?? "");
		const scopeId = String(event.payload?.scopeId ?? "");
		const lane = String(event.payload?.lane ?? "");
		return (
			FINANCE_JOB_LANES.has(lane) ||
			kind.includes("finance") ||
			kind.includes("tax") ||
			kind.includes("registry") ||
			scopeId === "finance" ||
			scopeId === "registry_suggestions"
		);
	};
	const financeJobIslands = (event) =>
		unique([
			...STATUS_ISLANDS,
			isTerminalJob(event) ? activeFinanceTabIsland() : null,
			event.payload?.lane === "export_report" ? "finance.export-health" : null,
		]);
	const onFinance = (event) =>
		void app.scheduleRefresh({
			islands: financeIslandHints(event),
			immediate: true,
			fallback: "none",
			source: "sse",
		});
	const onJobs = (event) => {
		if (!isFinanceJob(event)) {
			return;
		}
		void app.scheduleRefresh({
			islands: financeJobIslands(event),
			immediate: isTerminalJob(event),
			fallback: "none",
			source: "sse",
		});
	};
	const unsubscribers = [
		app.subscribe("finance", onFinance),
		app.subscribe("jobs", onJobs),
	];
	return () => {
		cleanupMutations();
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
