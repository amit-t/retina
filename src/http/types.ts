// Shared Hono type aliases so routes and middleware agree on what variables
// and bindings flow through the Context.
//
// Keep this file as a pure type surface — no runtime code. Real dependency
// injection happens in `buildApp` (see src/app.ts); individual middleware and
// routes just read from these typed `Variables`.

import type { Env } from 'hono';

export interface AppVariables {
  requestId: string;
}

export interface AppEnv extends Env {
  Variables: AppVariables;
}
