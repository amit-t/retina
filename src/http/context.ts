// Shared Hono env typing so every middleware and route sees the same
// `c.var.requestId`, `c.var.logger`, etc. Keep additions here narrow — anything
// per-request specific (e.g. auth principal once we add it) belongs here.

import type { Logger } from '../logger.js';

export interface AppVariables {
  requestId: string;
  logger: Logger;
}

export interface AppEnv {
  Variables: AppVariables;
}
