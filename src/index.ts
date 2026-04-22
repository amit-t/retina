// Placeholder entrypoint for the Retina service.
// The real bootstrap (config loader, logger, provider router, Hono app, etc.)
// lands in task R13. Until then this file only exists so that `tsc` has a
// valid `rootDir` target and `pnpm dev` / `pnpm build` have something to run.
process.exit(0);
