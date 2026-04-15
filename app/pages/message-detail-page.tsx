import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { JsonBlock } from "#/app/components/JsonBlock";
import { classifyOneNow } from "#/app/server/actions";

interface MessageDetailPageData {
	message: {
		id: string;
		subject: string | null;
		account_label: string;
		received_at: string | null;
		ingested_at: string;
		sender_address: string | null;
		body_text_primary: string;
		body_text_forwarded: string;
		body_text_normalized: string;
		to: unknown;
		cc: unknown;
		in_reply_to: string | null;
		thread_key: string;
		conversation_id: string | null;
		remote_thread_id: string | null;
		parse_status: string;
		body_extraction_strategy: string;
		parse_error_reason: string | null;
		token_estimate: number;
		content_sha256: string | null;
		raw_rfc822_path: string | null;
		raw_sha256: string | null;
	};
	currentLabel: { label: unknown } | null;
	classifications: Array<{
		id: string;
		source: string;
		model: string;
		created_at: string;
		result: unknown;
	}>;
	attachments: unknown;
	moderation: unknown;
	latestProfile: unknown;
	financeIntel: {
		head: {
			status: string;
			lowConfidence: number;
			contentSha256: string | null;
			registrySha256: string | null;
			updatedAt: string;
		};
		current: {
			id: string;
			schemaVersion: string | null;
			model: string | null;
			promptVersion: string | null;
			source: string | null;
			createdAt: string | null;
			result: unknown;
			rawResponse: unknown;
			usage: unknown;
		} | null;
		history: Array<{
			id: string;
			schemaVersion: string;
			model: string;
			promptVersion: string;
			source: string;
			createdAt: string;
			result: unknown;
			rawResponse: unknown;
			usage: unknown;
		}>;
		evidence: Array<{
			id: string;
			eventCandidateId: string | null;
			documentCandidateId: string | null;
			transactionIndex: number | null;
			documentIndex: number | null;
			eventCanonicalKey: string | null;
			eventStatus: string | null;
			documentCanonicalKey: string | null;
			documentStatus: string | null;
			evidenceJson: string;
		}>;
	} | null;
}

export function MessageDetailPage({ data }: { data: MessageDetailPageData }) {
	const router = useRouter();
	const classifyNow = useServerFn(classifyOneNow);

	return (
		<div className="page">
			<section className="card stack">
				<div className="row">
					<h1>{data.message.subject ?? "(no subject)"}</h1>
					<button
						className="button"
						type="button"
						onClick={async () => {
							await classifyNow({ data: { messageId: data.message.id } });
							await router.invalidate();
						}}
					>
						Classify now
					</button>
				</div>
				<div className="row muted">
					<span>{data.message.account_label}</span>
					<span>{data.message.received_at ?? "unknown date"}</span>
					<span>{data.message.sender_address ?? "unknown sender"}</span>
				</div>
			</section>

			<section className="two-up">
				<div className="stack">
					<div className="card stack">
						<h2>Primary body</h2>
						<pre className="json-block">
							{data.message.body_text_primary || "(empty)"}
						</pre>
					</div>

					{data.message.body_text_forwarded ? (
						<div className="card stack">
							<h2>Forwarded body</h2>
							<pre className="json-block">
								{data.message.body_text_forwarded}
							</pre>
						</div>
					) : null}

					<div className="card stack">
						<h2>Classifier/search body</h2>
						<pre className="json-block">
							{data.message.body_text_normalized || "(empty)"}
						</pre>
					</div>

					<div className="card stack">
						<h2>Current label</h2>
						<JsonBlock value={data.currentLabel?.label ?? null} />
					</div>

					<div className="card stack">
						<div className="row">
							<h2>Finance intel</h2>
							<Link className="button secondary" to="/finance">
								Open finance view
							</Link>
						</div>
						{data.financeIntel ? (
							<>
								<div className="row">
									<span className="pill">
										status: {data.financeIntel.head.status}
									</span>
									{data.financeIntel.head.lowConfidence ? (
										<span className="pill">Low confidence</span>
									) : null}
									<span className="pill">
										updated: {data.financeIntel.head.updatedAt}
									</span>
								</div>
								{data.financeIntel.current ? (
									<>
										<JsonBlock value={data.financeIntel.current.result} />
										<JsonBlock
											value={{
												model: data.financeIntel.current.model,
												promptVersion: data.financeIntel.current.promptVersion,
												source: data.financeIntel.current.source,
												createdAt: data.financeIntel.current.createdAt,
												registrySha256: data.financeIntel.head.registrySha256,
												contentSha256: data.financeIntel.head.contentSha256,
											}}
										/>
									</>
								) : (
									<p className="muted">
										No finance-intel result is stored for the current head.
									</p>
								)}
								{data.financeIntel.evidence.length > 0 ? (
									<div className="stack">
										<h3>Candidate links</h3>
										{data.financeIntel.evidence.map((row) => (
											<div key={row.id} className="card stack">
												<div className="row">
													{row.eventCandidateId ? (
														<span className="pill">
															event {row.eventCandidateId}
														</span>
													) : null}
													{row.documentCandidateId ? (
														<span className="pill">
															document {row.documentCandidateId}
														</span>
													) : null}
													{row.eventStatus ? (
														<span className="pill">{row.eventStatus}</span>
													) : null}
													{row.documentStatus ? (
														<span className="pill">{row.documentStatus}</span>
													) : null}
												</div>
												<pre className="json-block">{row.evidenceJson}</pre>
											</div>
										))}
									</div>
								) : null}
							</>
						) : (
							<p className="muted">
								No finance-intel head exists for this message yet.
							</p>
						)}
					</div>

					<div className="card stack">
						<h2>Classification history</h2>
						{data.classifications.map((entry) => (
							<div key={entry.id} className="card stack">
								<div className="row">
									<span className="pill">{entry.source}</span>
									<span className="pill">{entry.model}</span>
									<span className="pill">{entry.created_at}</span>
								</div>
								<JsonBlock value={entry.result} />
							</div>
						))}
					</div>
				</div>

				<div className="stack">
					<div className="card stack">
						<h2>Metadata</h2>
						<JsonBlock
							value={{
								receivedAt: data.message.received_at,
								ingestedAt: data.message.ingested_at,
								to: data.message.to,
								cc: data.message.cc,
								inReplyTo: data.message.in_reply_to,
								threadKey: data.message.thread_key,
								conversationId: data.message.conversation_id,
								remoteThreadId: data.message.remote_thread_id,
								parseStatus: data.message.parse_status,
								bodyExtractionStrategy: data.message.body_extraction_strategy,
								parseErrorReason: data.message.parse_error_reason,
								tokenEstimate: data.message.token_estimate,
								contentSha256: data.message.content_sha256,
								rawRfc822Path: data.message.raw_rfc822_path,
								rawSha256: data.message.raw_sha256,
							}}
						/>
					</div>

					<div className="card stack">
						<h2>Attachments</h2>
						<JsonBlock value={data.attachments} />
					</div>

					<div className="card stack">
						<h2>Moderation</h2>
						<JsonBlock value={data.moderation} />
					</div>

					<div className="card stack">
						<h2>Latest overseer profile</h2>
						<JsonBlock value={data.latestProfile} />
					</div>

					{data.financeIntel?.history.length ? (
						<div className="card stack">
							<h2>Finance-intel history</h2>
							{data.financeIntel.history.map((entry) => (
								<div key={entry.id} className="card stack">
									<div className="row">
										<span className="pill">{entry.source}</span>
										<span className="pill">{entry.model}</span>
										<span className="pill">{entry.createdAt}</span>
									</div>
									<JsonBlock value={entry.result} />
								</div>
							))}
						</div>
					) : null}
				</div>
			</section>
		</div>
	);
}
