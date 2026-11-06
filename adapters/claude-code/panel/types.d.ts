export type Quota = { remaining_pct: number; resets_at: string | null };
export type Account = { id: string; label: string; quota: { session: Quota | null; weekly: Quota | null } };
export type Run = {
  id: string; status: string | null; stale: boolean; account: string | null;
  actor: string | null; model: string | null; effort: string | null;
  elapsed_seconds: number | null; last_progress: string | null; started_at?: string;
  demand?: string | null; finish_reason?: string | null;
};
export type State = {
  schema_version: 1; client: 'claude'; accounts: Account[]; runs: Run[];
  readiness: string; warnings: string[]; skipped_runs?: number;
  launchable?: { account: string; actor_classes?: string[]; can_launch: boolean }[];
};
export type Result = { ok: true; state: State } | { ok: false; error: string };
export type Runner = (args: string[], options: { timeoutMs: number; maxOutputBytes: number }) =>
  Promise<{ exitCode: number; stdout: string }>;
export type Timer = { cancel(): void };
export type Clock = { every(ms: number, tick: () => void): Timer };
// Minimal test contract inferred from the reference; not a vendor API declaration.
export type Engine = {
  process: { run: Runner }; clock: Clock;
  command: { register(command: { name: string; description: string }): Promise<void> };
  ui: {
    open(pane: { id: string; title: string }): Promise<void>;
    close(pane: { id: string }): Promise<void>;
    panes(): Promise<{ id: string }[]>;
    invalidate(event: string): void;
    resolve(event: Event): { Box: unknown; Text: unknown };
  };
};
export type Event = { props?: { bodyColumns?: number } };
export type Handler = ($: Engine, event: Event, next: (event: Event) => unknown) => unknown;
export type On = {
  (event: string, handler: Handler): void;
  (event: string, filter: Record<string, string>, handler: Handler): void;
};
declare global {
  // Supplied by the mod host in JavaScript as well as TSX.
  function h(type: unknown, props: Record<string, unknown>, ...children: unknown[]): unknown;
}
