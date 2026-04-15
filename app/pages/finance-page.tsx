import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import {
	queueImportOperatorRegistry,
	queueRebuildFinanceKnowledge,
	queueRebuildFinanceRollups,
	queueReconcileRegistrySuggestions,
} from "#/app/server/actions";

type FinanceSourceKind = "email" | "pdf" | "statement" | "csv" | "ofx";

interface FinancePageData {
	year: number;
	availableYears: number[];
	filters: {
		accountId: string | null;
		institutionId: string | null;
		ownerIdentityId: string | null;
		sourceKind: FinanceSourceKind | null;
		accounts: Array<{ id: string; label: string }>;
		institutions: Array<{ id: string; label: string }>;
		ownerIdentities: Array<{ id: string; label: string }>;
		sourceKinds: string[];
	};
	registry: {
		sha256: string | null;
		importedAt: string | null;
		sourceDir: string;
		counts: {
			identities: number;
			institutions: number;
			financialAccounts: number;
			senderRules: number;
		};
	};
	coverage: {
		rootFinanceRelevantCount: number;
		totalHeads: number;
		financeV2HeadCount?: number;
		readyCount: number;
		reviewCount: number;
		staleCount: number;
		blockedParseErrorCount: number;
		eventCandidateCount: number;
		documentCandidateCount: number;
	};
	pipelineStatus: {
		rootFinanceRelevantCount: number;
		financeHeadCount: number;
		financeV2HeadCount: number;
		knowledgeMaterialized: boolean;
		registryImportedAt: string | null;
		jobs: Record<string, { queued: number; running: number }>;
	};
	summary: {
		inflowMinor: number;
		outflowMinor: number;
		netMinor: number;
		importedStatementCount: number;
		extractedTransactionCount: number;
		uncategorizedCount: number;
	};
	rollups: Array<{
		year: number;
		sourceKind: string;
		primaryCategory: string;
		inflowMinor: number;
		outflowMinor: number;
		netMinor: number;
		transactionCount: number;
		importedStatementCount: number;
		extractedTransactionCount: number;
		uncategorizedCount: number;
	}>;
	subcategoryRollups: Array<{
		year: number;
		sourceKind: string;
		primaryCategory: string;
		secondaryCategory: string;
		inflowMinor: number;
		outflowMinor: number;
		netMinor: number;
		transactionCount: number;
	}>;
	ledgerPreview: Array<{
		sourceKind: string;
		accountId: string | null;
		year: number;
		primaryCategory: string;
		secondaryCategory: string | null;
		direction: string;
		amountMinor: number | null;
		occurredAt: string | null;
		ownerIdentityId: string | null;
		institutionId: string | null;
		financialAccountId: string | null;
		description: string | null;
	}>;
	importedDocuments: Array<{
		id: string;
		documentType: string;
		issuer: string | null;
		externalId: string | null;
		statementPeriodStart: string | null;
		statementPeriodEnd: string | null;
		dueAt: string | null;
		taxYear: number | null;
		ownerIdentityHint: string | null;
		financialAccountHint: string | null;
		institutionHint: string | null;
		evidenceText: string;
	}>;
	registrySuggestions: Array<{
		id: string;
		entityKind: string;
		canonicalKey: string;
		sourceKind: string;
		confidence: number;
		status: string;
		appliedRegistryId: string | null;
		suggestion: unknown;
		updatedAt: string;
	}>;
	eventCandidates: Array<{
		id: string;
		eventKind: string;
		status: string;
		amountValue: string | null;
		currency: string | null;
		merchantOrCounterparty: string | null;
		evidenceCount: number;
	}>;
	documentCandidates: Array<{
		id: string;
		documentType: string;
		status: string;
		issuer: string | null;
		externalId: string | null;
		evidenceCount: number;
	}>;
}

function formatMoney(minor: number) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(minor / 100);
}

function SummaryCard(input: { label: string; value: string }) {
	return (
		<div className="card stack">
			<div className="muted">{input.label}</div>
			<strong>{input.value}</strong>
		</div>
	);
}

export function FinancePage({ data }: { data: FinancePageData }) {
	const router = useRouter();
	const importRegistry = useServerFn(queueImportOperatorRegistry);
	const rebuildKnowledge = useServerFn(queueRebuildFinanceKnowledge);
	const rebuildRollups = useServerFn(queueRebuildFinanceRollups);
	const reconcileSuggestions = useServerFn(queueReconcileRegistrySuggestions);
	const defaults: FinancePageData = {
		year: new Date().getUTCFullYear(),
		availableYears: [new Date().getUTCFullYear()],
		filters: {
			accountId: null,
			institutionId: null,
			ownerIdentityId: null,
			sourceKind: null,
			accounts: [],
			institutions: [],
			ownerIdentities: [],
			sourceKinds: [],
		},
		registry: {
			sha256: null,
			importedAt: null,
			sourceDir: "",
			counts: {
				identities: 0,
				institutions: 0,
				financialAccounts: 0,
				senderRules: 0,
			},
		},
		coverage: {
			rootFinanceRelevantCount: 0,
			totalHeads: 0,
			financeV2HeadCount: 0,
			readyCount: 0,
			reviewCount: 0,
			staleCount: 0,
			blockedParseErrorCount: 0,
			eventCandidateCount: 0,
			documentCandidateCount: 0,
		},
		pipelineStatus: {
			rootFinanceRelevantCount: 0,
			financeHeadCount: 0,
			financeV2HeadCount: 0,
			knowledgeMaterialized: false,
			registryImportedAt: null,
			jobs: {
				classify_finance_backlog: { queued: 0, running: 0 },
				rebuild_finance_knowledge: { queued: 0, running: 0 },
				rebuild_finance_rollups: { queued: 0, running: 0 },
			},
		},
		summary: {
			inflowMinor: 0,
			outflowMinor: 0,
			netMinor: 0,
			importedStatementCount: 0,
			extractedTransactionCount: 0,
			uncategorizedCount: 0,
		},
		rollups: [],
		subcategoryRollups: [],
		ledgerPreview: [],
		importedDocuments: [],
		registrySuggestions: [],
		eventCandidates: [],
		documentCandidates: [],
	};
	const view = Object.assign({}, defaults, data, {
		filters: {
			...defaults.filters,
			...(data.filters ?? {}),
		},
		registry: {
			...defaults.registry,
			...(data.registry ?? {}),
			counts: {
				...defaults.registry.counts,
				...(data.registry?.counts ?? {}),
			},
		},
		coverage: {
			...defaults.coverage,
			...(data.coverage ?? {}),
		},
		pipelineStatus: {
			...defaults.pipelineStatus,
			...(data.pipelineStatus ?? {}),
			jobs: {
				...defaults.pipelineStatus.jobs,
				...(data.pipelineStatus?.jobs ?? {}),
			},
		},
		summary: {
			...defaults.summary,
			...(data.summary ?? {}),
		},
	}) as FinancePageData;
	const warnings: string[] = [];
	if (!view.registry.importedAt) {
		warnings.push("Registry has not been imported yet.");
	}
	if (
		view.pipelineStatus.financeHeadCount <
			view.pipelineStatus.rootFinanceRelevantCount ||
		view.pipelineStatus.financeV2HeadCount <
			view.pipelineStatus.financeHeadCount
	) {
		warnings.push(
			"Finance classifier coverage is incomplete or still contains non-v2 heads.",
		);
	}
	if (
		!view.pipelineStatus.knowledgeMaterialized &&
		view.pipelineStatus.financeV2HeadCount > 0
	) {
		warnings.push("Finance knowledge tables are still empty.");
	}
	const resetFiltersSearch = { year: view.year };
	const hasActiveNonYearFilters = Boolean(
		view.filters.accountId ||
			view.filters.institutionId ||
			view.filters.ownerIdentityId ||
			view.filters.sourceKind,
	);

	return (
		<div className="page">
			<section className="card stack">
				<div className="row">
					<h1>Finance knowledge</h1>
					<div className="actions">
						<button
							className="button"
							type="button"
							onClick={async () => {
								await importRegistry();
								await router.invalidate();
							}}
						>
							Import registry
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={async () => {
								await reconcileSuggestions();
								await router.invalidate();
							}}
						>
							Reconcile suggestions
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={async () => {
								await rebuildKnowledge();
								await router.invalidate();
							}}
						>
							Rebuild knowledge
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={async () => {
								await rebuildRollups();
								await router.invalidate();
							}}
						>
							Rebuild rollups
						</button>
					</div>
				</div>
				<p className="muted">
					Year-first finance view across email-derived extraction, imported
					artifacts, and registry suggestions.
				</p>
				<div className="row">
					<span className="pill">
						registry imported: {view.registry.importedAt ?? "never"}
					</span>
					<span className="pill">
						Registry sha: {view.registry.sha256 ?? "none"}
					</span>
					<span className="pill">
						root finance relevant: {view.coverage.rootFinanceRelevantCount}
					</span>
					<span className="pill">
						finance heads: {view.coverage.totalHeads}
					</span>
					<span className="pill">ready: {view.coverage.readyCount}</span>
					<span className="pill">stale: {view.coverage.staleCount}</span>
				</div>
				<div className="row muted">
					<span>Registry dir: {view.registry.sourceDir}</span>
					<span>Suggestions: {view.registrySuggestions.length}</span>
				</div>
				<div className="row">
					<span className="pill">
						finance v2 heads: {view.pipelineStatus.financeV2HeadCount}
					</span>
					<span className="pill">
						finance backlog q/r:{" "}
						{view.pipelineStatus.jobs.classify_finance_backlog?.queued ?? 0}/
						{view.pipelineStatus.jobs.classify_finance_backlog?.running ?? 0}
					</span>
					<span className="pill">
						knowledge q/r:{" "}
						{view.pipelineStatus.jobs.rebuild_finance_knowledge?.queued ?? 0}/
						{view.pipelineStatus.jobs.rebuild_finance_knowledge?.running ?? 0}
					</span>
					<span className="pill">
						rollups q/r:{" "}
						{view.pipelineStatus.jobs.rebuild_finance_rollups?.queued ?? 0}/
						{view.pipelineStatus.jobs.rebuild_finance_rollups?.running ?? 0}
					</span>
				</div>
				{warnings.length > 0 ? (
					<div className="stack">
						{warnings.map((warning) => (
							<p key={warning} className="muted">
								Warning: {warning}
							</p>
						))}
					</div>
				) : null}
			</section>

			<section className="card stack">
				<div className="row">
					<strong>Year</strong>
					<div className="row">
						{view.availableYears.map((year) => (
							<Link
								key={year}
								to="/finance"
								search={(prev: Record<string, unknown>) => ({
									...prev,
									year,
								})}
								className={year === view.year ? "pill" : "muted"}
							>
								{year}
							</Link>
						))}
					</div>
				</div>
				<div className="row">
					<span className="muted">Account filter</span>
					<Link to="/finance" search={resetFiltersSearch} className="pill">
						All
					</Link>
					{view.filters.accounts.map((account) => (
						<Link
							key={account.id}
							to="/finance"
							search={{ year: view.year, accountId: account.id }}
							className={
								view.filters.accountId === account.id ? "pill" : "muted"
							}
						>
							{account.label}
						</Link>
					))}
				</div>
				<div className="row">
					<span className="muted">Institution filter</span>
					<Link to="/finance" search={resetFiltersSearch} className="pill">
						All
					</Link>
					{view.filters.institutions.map((institution) => (
						<Link
							key={institution.id}
							to="/finance"
							search={{
								year: view.year,
								accountId: view.filters.accountId ?? undefined,
								institutionId: institution.id,
								ownerIdentityId: view.filters.ownerIdentityId ?? undefined,
								sourceKind: view.filters.sourceKind ?? undefined,
							}}
							className={
								view.filters.institutionId === institution.id ? "pill" : "muted"
							}
						>
							{institution.label}
						</Link>
					))}
				</div>
				<div className="row">
					<span className="muted">Identity filter</span>
					<Link to="/finance" search={resetFiltersSearch} className="pill">
						All
					</Link>
					{view.filters.ownerIdentities.map((identity) => (
						<Link
							key={identity.id}
							to="/finance"
							search={{
								year: view.year,
								accountId: view.filters.accountId ?? undefined,
								institutionId: view.filters.institutionId ?? undefined,
								ownerIdentityId: identity.id,
								sourceKind: view.filters.sourceKind ?? undefined,
							}}
							className={
								view.filters.ownerIdentityId === identity.id ? "pill" : "muted"
							}
						>
							{identity.label}
						</Link>
					))}
				</div>
				<div className="row">
					<span className="muted">Source filter</span>
					<Link to="/finance" search={resetFiltersSearch} className="pill">
						All
					</Link>
					{view.filters.sourceKinds.map((sourceKind) => (
						<Link
							key={sourceKind}
							to="/finance"
							search={{
								year: view.year,
								accountId: view.filters.accountId ?? undefined,
								institutionId: view.filters.institutionId ?? undefined,
								ownerIdentityId: view.filters.ownerIdentityId ?? undefined,
								sourceKind: sourceKind as FinanceSourceKind,
							}}
							className={
								view.filters.sourceKind === sourceKind ? "pill" : "muted"
							}
						>
							{sourceKind}
						</Link>
					))}
				</div>
				{hasActiveNonYearFilters ? (
					<div className="row">
						<Link to="/finance" search={resetFiltersSearch} className="button secondary">
							Clear filters
						</Link>
					</div>
				) : null}
			</section>

			<section className="grid-3">
				<SummaryCard
					label="Inflow"
					value={formatMoney(view.summary.inflowMinor)}
				/>
				<SummaryCard
					label="Outflow"
					value={formatMoney(view.summary.outflowMinor)}
				/>
				<SummaryCard label="Net" value={formatMoney(view.summary.netMinor)} />
				<SummaryCard
					label="Imported statements"
					value={String(view.summary.importedStatementCount)}
				/>
				<SummaryCard
					label="Extracted transactions"
					value={String(view.summary.extractedTransactionCount)}
				/>
				<SummaryCard
					label="Uncategorized"
					value={String(view.summary.uncategorizedCount)}
				/>
			</section>

			<section className="two-up">
				<section className="card stack">
					<h2>Primary rollups</h2>
					{view.rollups.length === 0 ? (
						<p className="muted">No yearly rollups yet.</p>
					) : (
						view.rollups.map((row) => (
							<div
								key={`${row.sourceKind}-${row.primaryCategory}`}
								className="row"
							>
								<strong>{row.primaryCategory}</strong>
								<span className="pill">{row.sourceKind}</span>
								<span className="muted">
									{formatMoney(row.inflowMinor)} in /{" "}
									{formatMoney(row.outflowMinor)} out /{" "}
									{formatMoney(row.netMinor)} net
								</span>
								<span className="muted">txns: {row.transactionCount}</span>
							</div>
						))
					)}
				</section>

				<section className="card stack">
					<h2>Subcategory rollups</h2>
					{view.subcategoryRollups.length === 0 ? (
						<p className="muted">No subcategory rollups yet.</p>
					) : (
						view.subcategoryRollups.map((row) => (
							<div
								key={`${row.sourceKind}-${row.primaryCategory}-${row.secondaryCategory}`}
								className="row"
							>
								<strong>
									{row.primaryCategory} / {row.secondaryCategory}
								</strong>
								<span className="pill">{row.sourceKind}</span>
								<span className="muted">{formatMoney(row.netMinor)}</span>
								<span className="muted">txns: {row.transactionCount}</span>
							</div>
						))
					)}
				</section>
			</section>

			<section className="two-up">
				<section className="card stack">
					<h2>Ledger preview</h2>
					{view.ledgerPreview.length === 0 ? (
						<p className="muted">No ledger entries for this selection.</p>
					) : (
						view.ledgerPreview.map((entry) => (
							<div
								key={[
									entry.sourceKind,
									entry.year,
									entry.occurredAt ?? "unknown-date",
									entry.primaryCategory,
									entry.secondaryCategory ?? "no-secondary",
									entry.description ?? "no-description",
									entry.amountMinor ?? "no-amount",
								].join(":")}
								className="card stack"
							>
								<div className="row">
									<strong>{entry.description ?? "(no description)"}</strong>
									<span className="pill">{entry.sourceKind}</span>
									<span className="pill">{entry.primaryCategory}</span>
									{entry.secondaryCategory ? (
										<span className="pill">{entry.secondaryCategory}</span>
									) : null}
								</div>
								<div className="row muted">
									<span>{entry.occurredAt ?? "unknown date"}</span>
									<span>{entry.direction}</span>
									<span>
										{entry.amountMinor === null
											? "unknown amount"
											: formatMoney(entry.amountMinor)}
									</span>
								</div>
							</div>
						))
					)}
				</section>

				<section className="card stack">
					<h2>Imported documents</h2>
					{view.importedDocuments.length === 0 ? (
						<p className="muted">No imported documents for this year.</p>
					) : (
						view.importedDocuments.map((document) => (
							<div key={document.id} className="card stack">
								<div className="row">
									<strong>{document.documentType}</strong>
									<span className="pill">
										{document.issuer ?? "unknown issuer"}
									</span>
								</div>
								<div className="row muted">
									<span>{document.statementPeriodStart ?? "?"}</span>
									<span>{document.statementPeriodEnd ?? "?"}</span>
									<span>tax year: {document.taxYear ?? "n/a"}</span>
								</div>
								<p>{document.evidenceText}</p>
							</div>
						))
					)}
				</section>
			</section>

			<section className="two-up">
				<section className="card stack">
					<h2>Registry suggestions</h2>
					{view.registrySuggestions.length === 0 ? (
						<p className="muted">No registry suggestions yet.</p>
					) : (
						view.registrySuggestions.map((suggestion) => (
							<div key={suggestion.id} className="card stack">
								<div className="row">
									<strong>{suggestion.entityKind}</strong>
									<span className="pill">{suggestion.status}</span>
									<span className="pill">
										{Math.round(suggestion.confidence * 100)}%
									</span>
								</div>
								<div className="row muted">
									<span>{suggestion.canonicalKey}</span>
									<span>{suggestion.sourceKind}</span>
									<span>{suggestion.updatedAt}</span>
								</div>
								<pre>{JSON.stringify(suggestion.suggestion, null, 2)}</pre>
							</div>
						))
					)}
				</section>

				<section className="card stack">
					<h2>Email-derived candidates</h2>
					<div className="stack">
						<strong>Events</strong>
						{view.eventCandidates.length === 0 ? (
							<p className="muted">No materialized event candidates.</p>
						) : (
							view.eventCandidates.map((row) => (
								<div key={row.id} className="row">
									<span>{row.eventKind}</span>
									<span className="pill">{row.status}</span>
									<span className="muted">
										{row.amountValue ?? "?"} {row.currency ?? ""}
									</span>
									<span className="muted">
										{row.merchantOrCounterparty ?? "unknown"}
									</span>
								</div>
							))
						)}
						<strong>Documents</strong>
						{view.documentCandidates.length === 0 ? (
							<p className="muted">No materialized document candidates.</p>
						) : (
							view.documentCandidates.map((row) => (
								<div key={row.id} className="row">
									<span>{row.documentType}</span>
									<span className="pill">{row.status}</span>
									<span className="muted">
										{row.issuer ?? "unknown issuer"}
									</span>
									<span className="muted">
										{row.externalId ?? "no external id"}
									</span>
								</div>
							))
						)}
					</div>
				</section>
			</section>
		</div>
	);
}
