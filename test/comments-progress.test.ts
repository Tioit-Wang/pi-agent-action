import { describe, expect, test } from "bun:test";
import {
  buildProgressBody,
  createProgressPublisher,
  type ProgressUpdate,
} from "../src/github/operations/comments/progress";
import { buildOutcomeNotice } from "../src/github/operations/comments/agent-answer";

describe("buildProgressBody", () => {
  test("shows the turn, the elapsed time, the last tool and the job link", () => {
    const body = buildProgressBody(
      { turns: 42, elapsedMs: 195_000, lastTool: "bash" },
      "[View job run](https://example.test/run/1)",
    );

    expect(body).toContain("Pi is working…");
    expect(body).toContain("turn 42");
    expect(body).toContain("3m 15s");
    expect(body).toContain("last tool `bash`");
    expect(body).toContain("[View job run](https://example.test/run/1)");
  });

  test("omits the tool when none has finished yet", () => {
    const body = buildProgressBody({ turns: 1, elapsedMs: 5_000 }, "job");

    expect(body).toContain("turn 1");
    expect(body).toContain("5s");
    expect(body).not.toContain("last tool");
  });
});

describe("createProgressPublisher", () => {
  const update = (turns: number, elapsedMs = 0): ProgressUpdate => ({
    turns,
    elapsedMs,
  });

  test("stays quiet until the interval or the turn gap is reached", async () => {
    const posted: string[] = [];
    let clock = 1_000;
    const publish = createProgressPublisher({
      post: async (body) => {
        posted.push(body);
      },
      build: (u) => `turn ${u.turns}`,
      now: () => clock,
      minIntervalMs: 30_000,
      minTurns: 10,
    });

    publish(update(1));
    await Promise.resolve();
    expect(posted).toEqual([]);

    clock += 31_000;
    publish(update(2));
    await Promise.resolve();
    expect(posted).toEqual(["turn 2"]);
  });

  test("publishes on the turn gap even before the interval elapses", async () => {
    const posted: string[] = [];
    const publish = createProgressPublisher({
      post: async (body) => {
        posted.push(body);
      },
      build: (u) => `turn ${u.turns}`,
      now: () => 0,
      minIntervalMs: 600_000,
      minTurns: 5,
    });

    publish(update(5));
    await Promise.resolve();

    expect(posted).toEqual(["turn 5"]);
  });

  test("never overlaps two edits and survives a rejected edit", async () => {
    let release: (() => void) | undefined;
    const posted: string[] = [];
    let clock = 0;
    const publish = createProgressPublisher({
      post: (body) => {
        posted.push(body);
        return new Promise<void>((resolve, reject) => {
          release = () => {
            if (body === "turn 2") reject(new Error("boom"));
            else resolve();
          };
        });
      },
      build: (u) => `turn ${u.turns}`,
      now: () => clock,
      minIntervalMs: 0,
      minTurns: 1,
      log: () => {},
    });

    publish(update(1));
    publish(update(2));
    // Second call is dropped: the first edit is still in flight.
    expect(posted).toEqual(["turn 1"]);

    release?.();
    await Promise.resolve();
    await Promise.resolve();

    clock = 10;
    publish(update(3));
    expect(posted).toEqual(["turn 1", "turn 3"]);
    release?.();
  });
});

describe("buildOutcomeNotice", () => {
  test("says the run was cancelled, with turns and duration", () => {
    const notice = buildOutcomeNotice({
      cancelled: true,
      turns: 104,
      durationMs: 1_193_000,
    });

    expect(notice).toContain("Pi was cancelled before writing an answer");
    expect(notice).toContain("after 104 turns");
    expect(notice).toContain("19m 53s");
  });

  test("says the run stopped and repeats the reason", () => {
    const notice = buildOutcomeNotice({
      turns: 16,
      reason: "Pi reported 16 turns, exceeding the configured maximum of 15",
    });

    expect(notice).toContain("Pi stopped before writing an answer after 16 turns");
    expect(notice).toContain("exceeding the configured maximum of 15");
  });
});
