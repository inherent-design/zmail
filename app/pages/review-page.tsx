import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { JsonBlock } from "#/app/components/JsonBlock";
import { resolveReview } from "#/app/server/actions";
import type { MessageLabel } from "#/lib/schemas";

interface ReviewPageData {
	id: string;
	subject: string | null;
	sender_address: string | null;
	snippet: string;
	body_extraction_strategy: string;
	has_forwarded: boolean;
	parse_status: string;
	parse_error_reason: string | null;
	result: unknown;
}

export function ReviewPage({ data }: { data: ReviewPageData[] }) {
	const router = useRouter();
	const resolve = useServerFn(resolveReview);
	const [drafts, setDrafts] = useState<Record<string, string>>(
		Object.fromEntries(
			data.map((row) => [row.id, JSON.stringify(row.result, null, 2)]),
		),
	);
	const [errors, setErrors] = useState<Record<string, string>>({});

	return (
		<div className="page">
			<section className="card stack">
				<h1>Low-confidence review</h1>
				<p className="muted">Open reviews only.</p>
			</section>

			{data.map((row) => (
				<section key={row.id} className="card stack">
					<div className="row">
						<strong>{row.subject ?? "(no subject)"}</strong>
						<span className="pill">
							{row.sender_address ?? "unknown sender"}
						</span>
						<span className="pill">{row.body_extraction_strategy}</span>
						{row.has_forwarded ? <span className="pill">Forwarded</span> : null}
						{row.parse_status === "error" ? (
							<span className="pill">Parse error</span>
						) : null}
					</div>
					<p>{row.snippet}</p>
					{row.parse_status === "error" && row.parse_error_reason ? (
						<p className="muted">Parse issue: {row.parse_error_reason}</p>
					) : null}
					<JsonBlock value={row.result} />
					<label>
						Override JSON
						<textarea
							rows={14}
							value={drafts[row.id] ?? ""}
							onChange={(event) => {
								setDrafts((current) => ({
									...current,
									[row.id]: event.target.value,
								}));
								setErrors((current) => {
									if (!(row.id in current)) {
										return current;
									}
									const next = { ...current };
									delete next[row.id];
									return next;
								});
							}}
						/>
					</label>
					{errors[row.id] ? (
						<p className="muted" role="alert">
							Override error: {errors[row.id]}
						</p>
					) : null}
					<div className="actions">
						<button
							className="button secondary"
							type="button"
							onClick={async () => {
								await resolve({
									data: {
										reviewId: row.id,
										action: "accept",
									},
								});
								await router.invalidate();
							}}
						>
							Accept
						</button>
						<button
							className="button"
							type="button"
							onClick={async () => {
								let override: MessageLabel;
								try {
									override = JSON.parse(drafts[row.id] ?? "{}") as MessageLabel;
								} catch {
									setErrors((current) => ({
										...current,
										[row.id]: "Override JSON must be valid JSON.",
									}));
									return;
								}

								try {
									await resolve({
										data: {
											reviewId: row.id,
											action: "override",
											override,
										},
									});
									await router.invalidate();
								} catch (error) {
									setErrors((current) => ({
										...current,
										[row.id]:
											error instanceof Error ? error.message : String(error),
									}));
								}
							}}
						>
							Override
						</button>
					</div>
				</section>
			))}
		</div>
	);
}
