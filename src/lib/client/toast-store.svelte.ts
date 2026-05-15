import type { ClientMutationEnvelope } from "#/lib/client-contract";

export type Toast = NonNullable<ClientMutationEnvelope["toast"]> & {
	id: string;
};

let toasts = $state<Toast[]>([]);

export function useToasts() {
	return {
		get items() {
			return toasts;
		},
		push(toast: ClientMutationEnvelope["toast"]) {
			if (!toast) {
				return;
			}
			const id = crypto.randomUUID();
			toasts = [...toasts, { ...toast, id }];
			setTimeout(() => {
				toasts = toasts.filter((item) => item.id !== id);
			}, 5000);
		},
		dismiss(id: string) {
			toasts = toasts.filter((item) => item.id !== id);
		},
	};
}
