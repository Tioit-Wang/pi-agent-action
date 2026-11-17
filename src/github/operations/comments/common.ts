import { GITHUB_SERVER_URL } from "../../api/config";

/**
 * Inline "working" indicator for the tracking comment.
 *
 * GitHub strips inline SVG from issue comments, so the mascot ships as two
 * animated GIFs (`assets/pi-mascot-{light,dark}.gif`, 32 frames, 4 s loop) and
 * is dispatched by `prefers-color-scheme` through `<picture>`, which the
 * comment renderer keeps. Monochrome line art, exactly like the brand mark:
 * dark ink on light themes, light ink on dark themes.
 */
const ASSET_URL =
  "https://raw.githubusercontent.com/Tioit-Wang/pi-agent-action/main/assets";

export const SPINNER_HTML =
  `<picture>` +
  `<source media="(prefers-color-scheme: dark)" srcset="${ASSET_URL}/pi-mascot-dark.gif">` +
  `<img src="${ASSET_URL}/pi-mascot-light.gif" width="18px" height="18px" style="vertical-align: middle; margin-left: 4px;" />` +
  `</picture>`;

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

/** Encode Git-ref path segments without turning `/` into `%2F`. */
export function encodeBranchNameForUrl(branchName: string): string {
  return branchName.split("/").map(encodeURIComponent).join("/");
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${encodeBranchNameForUrl(branchName)}`;
  return `\n[View branch](${branchUrl})`;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
): string {
  return `Pi is working… ${SPINNER_HTML}

I'll analyze this and get back to you.

${jobRunLink}${branchLink}`;
}

/** Human duration such as `2m 5s`, for comment bodies. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
