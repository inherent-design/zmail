import { BarChart, LineChart, PieChart } from "echarts/charts.js";
import {
	DatasetComponent,
	DataZoomComponent,
	GridComponent,
	LegendComponent,
	TooltipComponent,
} from "echarts/components.js";
import * as echarts from "echarts/core.js";
import { CanvasRenderer } from "echarts/renderers.js";

echarts.use([
	CanvasRenderer,
	LineChart,
	BarChart,
	PieChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	DatasetComponent,
	DataZoomComponent,
]);

const charts = new WeakMap();

export function financeChartTheme() {
	return {
		color: ["#2563eb", "#dc2626", "#059669", "#7c3aed", "#d97706"],
		textStyle: {
			fontFamily:
				'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		},
	};
}

export function initChart(element, option) {
	disposeChart(element);
	const chart = echarts.init(element, financeChartTheme(), {
		renderer: "canvas",
	});
	chart.setOption(option, true);
	charts.set(element, chart);
	const resize = () => chart.resize();
	window.addEventListener("resize", resize);
	return {
		chart,
		dispose() {
			window.removeEventListener("resize", resize);
			disposeChart(element);
		},
	};
}

export function getChart(element) {
	return charts.get(element) ?? null;
}

export function disposeChart(element) {
	const chart = charts.get(element);
	if (!chart) {
		return;
	}
	chart.dispose();
	charts.delete(element);
}
