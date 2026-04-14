import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { JsonBlock } from "#/app/components/JsonBlock";
import { enqueueOverseer } from "#/app/server/actions";

interface ProfilePageData {
	account: {
		id: string;
		label: string;
		email_address: string;
	};
	profiles: Array<{
		id: string;
		created_at: string;
		built_from_messages: number;
		profile: unknown;
	}>;
}

export function ProfilePage({ data }: { data: ProfilePageData }) {
	const router = useRouter();
	const queueOverseer = useServerFn(enqueueOverseer);

	return (
		<div className="page">
			<section className="card stack">
				<div className="row">
					<h1>{data.account.label}</h1>
					<button
						className="button"
						type="button"
						onClick={async () => {
							await queueOverseer({
								data: {
									accountId: data.account.id,
								},
							});
							await router.invalidate();
						}}
					>
						Queue overseer rebuild
					</button>
				</div>
				<p className="muted">{data.account.email_address}</p>
			</section>

			{data.profiles.length === 0 ? (
				<section className="card stack">
					<h2>No overseer profile yet</h2>
					<p className="muted">
						Queue a rebuild to generate the first profile for this account.
					</p>
				</section>
			) : (
				data.profiles.map((profile) => (
					<section key={profile.id} className="card stack">
						<div className="row">
							<span className="pill">{profile.created_at}</span>
							<span className="pill">
								{profile.built_from_messages} messages
							</span>
						</div>
						<JsonBlock value={profile.profile} />
					</section>
				))
			)}
		</div>
	);
}
