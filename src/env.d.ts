/// <reference types="vite/client" />

declare module "*.css" {}

interface ImportMetaEnv {
  /** Cloud orchestrator (stage 1) NDJSON endpoint. When unset, the simulator runs. */
  readonly VITE_ORCHESTRATOR_URL?: string;
  /** Cloud agent (stage 2) ingestion endpoint. When unset, the simulator runs. */
  readonly VITE_AGENT_URL?: string;
}
