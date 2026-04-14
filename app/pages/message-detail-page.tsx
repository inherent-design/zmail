import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { JsonBlock } from "#/app/components/JsonBlock";
import { classifyOneNow } from "#/app/server/actions";

interface MessageDetailPageData {
	message: {
		id: string;
		subject: string | null;
		account_label: string;
		received_at: string | null;
		sender_address: string | null;
		body_text_normalized: string;
		to: unknown;
		cc: unknown;
		in_reply_to: string | null;
		thread_key: string;
		parse_status: string;
		token_estimate: number;
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
						<h2>Normalized body</h2>
						<pre className="json-block">
							{data.message.body_text_normalized}
						</pre>
					</div>

					<div className="card stack">
						<h2>Current label</h2>
						<JsonBlock value={data.currentLabel?.label ?? null} />
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
						<h2>Headers</h2>
						<JsonBlock
							value={{
								to: data.message.to,
								cc: data.message.cc,
								inReplyTo: data.message.in_reply_to,
								threadKey: data.message.thread_key,
								parseStatus: data.message.parse_status,
								tokenEstimate: data.message.token_estimate,
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
				</div>
			</section>
		</div>
	);
}
