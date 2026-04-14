interface RunsPageData {
	jobs: Array<{
		id: string;
		kind: string;
		status: string;
		scope_type: string;
		scope_id: string;
		model: string | null;
		success_count: number;
		request_count: number;
		error_count: number;
		last_error: string | null;
		meta_json: string | null;
	}>;
	runtime: {
		preferredBackend: string;
		resolvedBackend: string | null;
	};
}

export function RunsPage({ data }: { data: RunsPageData }) {
	const { jobs, runtime } = data;

	return (
		<div className="page">
			<section className="card stack">
				<h1>Runs</h1>
				<p className="muted">
					Raw worker jobs for live sync, backlog classification, and overseer
					rebuilds.
				</p>
				<div className="row">
					<span className="pill">preferred: {runtime.preferredBackend}</span>
					<span className="pill">
						resolved: {runtime.resolvedBackend ?? "unavailable"}
					</span>
				</div>
			</section>

			<section className="card table-wrap">
				<table>
					<thead>
						<tr>
							<th>Kind</th>
							<th>Status</th>
							<th>Scope</th>
							<th>Model</th>
							<th>Counts</th>
							<th>Live meta</th>
						</tr>
					</thead>
					<tbody>
						{jobs.map((row) => {
							const meta =
								typeof row.meta_json === "string"
									? JSON.parse(row.meta_json)
									: {};
							return (
								<tr key={row.id}>
									<td>{row.kind}</td>
									<td>{row.status}</td>
									<td>
										{row.scope_type}:{row.scope_id}
									</td>
									<td>{row.model ?? "n/a"}</td>
									<td>
										{row.success_count}/{row.request_count} success,{" "}
										{row.error_count} errors
									</td>
									<td>
										<div className="stack">
											<span>
												processed: {String(meta.processed ?? 0)}/
												{String(meta.total ?? 0)}
											</span>
											<span>backend: {String(meta.backendUsed ?? "n/a")}</span>
											<span>
												last error:{" "}
												{row.last_error ??
													String(meta.lastErrorMessage ?? "none")}
											</span>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</section>
		</div>
	);
}
