import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		proxy: {
			"/api": "http://127.0.0.1:56711",
			"/auth": "http://127.0.0.1:56711",
			"/healthz": "http://127.0.0.1:56711",
			"/metrics": "http://127.0.0.1:56711",
			"/org": "http://127.0.0.1:56711",
			"/readyz": "http://127.0.0.1:56711",
			"/rpc": "http://127.0.0.1:56711",
			"/ws": {
				target: "ws://127.0.0.1:56711",
				ws: true,
			},
		},
	},
});
