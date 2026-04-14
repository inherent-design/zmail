import { Link } from "@tanstack/react-router";

interface HomePageData {
	messages: number;
	openReviews: number;
	jobs: number;
	accounts: number;
}

export function HomePage({ data }: { data: HomePageData }) {
	return (
		<div className="page">
			<section className="card stack">
				<h1>zmail</h1>
				<p className="muted">Gmail live-sync analysis workspace.</p>
			</section>

			<section className="stats">
				<div className="stat">
					<span className="muted">Accounts</span>
					<strong>{data.accounts}</strong>
				</div>
				<div className="stat">
					<span className="muted">Messages</span>
					<strong>{data.messages}</strong>
				</div>
				<div className="stat">
					<span className="muted">Open reviews</span>
					<strong>{data.openReviews}</strong>
				</div>
				<div className="stat">
					<span className="muted">Jobs</span>
					<strong>{data.jobs}</strong>
				</div>
			</section>

			<section className="card stack">
				<div className="actions">
					<Link className="button" to="/accounts/new">
						Connect Gmail
					</Link>
					<Link className="button" to="/accounts">
						Go to accounts
					</Link>
					<Link className="button secondary" to="/messages">
						Browse messages
					</Link>
					<Link className="button secondary" to="/review">
						Review low confidence
					</Link>
				</div>
			</section>
		</div>
	);
}
