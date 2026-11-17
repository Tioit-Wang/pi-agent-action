import { SPINNER_HTML, formatElapsed } from "./common";

/**
 * Live progress for the tracking comment.
 *
 * The action publishes the answer only when the run ends, so a long run is
 * invisible: a twenty minute analysis looks identical to a hung job. Rewriting
 * the same comment every so often turns the thread into the progress log the
 * job log cannot provide (GitHub only uploads job logs after the job ends).
 */

export type ProgressUpdate = {
  /** Completed assistant turns. */
  turns: number;
  elapsedMs: number;
  /** Last tool that finished, e.g. `bash`. */
  lastTool?: string;
};

export type ProgressPublisherOptions = {
  /** Posts the assembled body. Rejections are logged, never thrown. */
  post: (body: string) => Promise<void>;
  /** Defaults to buildProgressBody with a caller-supplied job URL. */
  build?: (update: ProgressUpdate) => string;
  /** Minimum time between two edits. Default 30s. */
  minIntervalMs?: number;
  /** Minimum turns between two edits. Default 10. */
  minTurns?: number;
  now?: () => number;
  log?: (message: string) => void;
};

/**
 * Same shape as the initial tracking comment, with the placeholder line
 * replaced by what the run is doing right now.
 */
export function buildProgressBody(
  update: ProgressUpdate,
  jobRunLink: string,
): string {
  const facts = [`turn ${update.turns}`, formatElapsed(update.elapsedMs)];
  if (update.lastTool) facts.push(`last tool \`${update.lastTool}\``);

  return `Pi is working… ${SPINNER_HTML}

_${facts.join(" · ")}_

${jobRunLink}`;
}

/**
 * Throttled publisher. The returned function is called once per turn and stays
 * cheap: it drops calls that are too close together, never overlaps two edits,
 * and swallows update failures so a comment edit cannot kill the run.
 */
export function createProgressPublisher(
  options: ProgressPublisherOptions,
): (update: ProgressUpdate) => void {
  const minIntervalMs = options.minIntervalMs ?? 30_000;
  const minTurns = options.minTurns ?? 10;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const build =
    options.build ??
    ((update: ProgressUpdate) => buildProgressBody(update, ""));

  let lastPublishedAt = now();
  let lastPublishedTurns = 0;
  let inFlight = false;

  return (update: ProgressUpdate): void => {
    if (inFlight) return;
    const due =
      update.turns - lastPublishedTurns >= minTurns ||
      now() - lastPublishedAt >= minIntervalMs;
    if (!due) return;

    inFlight = true;
    lastPublishedAt = now();
    lastPublishedTurns = update.turns;
    void options
      .post(build(update))
      .catch((error: unknown) => {
        log(`Progress update failed: ${String(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };
}
