globalThis.process ??= { env: {} };
globalThis.process.env ??= {};
globalThis.process.env.NODE_ENV ??= "production";
