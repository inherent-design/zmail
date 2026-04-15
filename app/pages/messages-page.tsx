import { Link } from "@tanstack/react-router";

interface MessagesPageData {
	id: string;
	received_at: string | null;
	conversation_id: string | null;
	remote_thread_id: string | null;
	body_extraction_strategy: string;
	parse_status: string;
	has_forwarded: boolean;
	account_label: string;
	sender_address: string | null;
	subject: string | null;
	primary_bucket: string | null;
	nsfw: number | null;
	low_confidence: number | null;
}

function formatConversationValue(value: string | null) {
	if (!value) {
		return "none";
	}
	if (value.length <= 18) {
		return value;
	}
	return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

export function MessagesPage({ data }: { data: MessagesPageData[] }) {
	return (
		<div className="page">
			<section className="card stack">
				<h1>Messages</h1>
				<p className="muted">Latest 250 normalized messages.</p>
			</section>

			<section className="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Date</th>
							<th>Account</th>
							<th>Sender</th>
							<th>Subject</th>
							<th>Conversation</th>
							<th>Extraction</th>
							<th>Bucket</th>
							<th>Flags</th>
						</tr>
					</thead>
					<tbody>
						{data.map((row) => (
							<tr key={row.id}>
								<td>{row.received_at ?? "unknown"}</td>
								<td>{row.account_label}</td>
								<td>{row.sender_address ?? "unknown"}</td>
								<td>
									<Link
										to="/messages/$messageId"
										params={{ messageId: row.id }}
									>
										{row.subject ?? "(no subject)"}
									</Link>
								</td>
								<td>
									{formatConversationValue(
										row.remote_thread_id ?? row.conversation_id,
									)}
								</td>
								<td>{row.body_extraction_strategy}</td>
								<td>{row.primary_bucket ?? "unlabeled"}</td>
								<td>
									<div className="row">
										{row.has_forwarded ? (
											<span className="pill">Forwarded</span>
										) : null}
										{row.parse_status === "error" ? (
											<span className="pill">Parse error</span>
										) : null}
										{row.nsfw ? <span className="pill">NSFW</span> : null}
										{row.low_confidence ? (
											<span className="pill">Low confidence</span>
										) : null}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
