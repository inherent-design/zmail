/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JsonBlock } from "#/app/components/JsonBlock";

describe("JsonBlock", () => {
	it("renders objects as pretty json", () => {
		render(<JsonBlock value={{ hello: "world" }} />);
		expect(screen.getByText(/"hello": "world"/)).toBeTruthy();
	});

	it("renders null", () => {
		render(<JsonBlock value={null} />);
		expect(screen.getByText("null")).toBeTruthy();
	});
});
