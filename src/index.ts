// Retina entrypoint stub.
// The real bootstrap (config → logger → providers → router → templates →
// jobStore (R14) → buildApp({…, jobStore}) → @hono/node-server) is assembled
// in task R13. Until then we exit cleanly so `node dist/index.js` and
// `tsx src/index.ts` are well-defined no-ops.
process.exit(0);
