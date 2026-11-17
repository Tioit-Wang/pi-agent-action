import { describe, expect, test } from "bun:test";
import { updateCommentBody } from "../src/github/operations/comment-logic";

const ANSWER = "The `version` field is `0.21.0`.";

function finalBody(currentBody: string): string {
  return updateCommentBody({
    currentBody,
    actionFailed: false,
    executionDetails: null,
    jobUrl: "https://example.test/run/1",
  } as never);
}

describe("working marker", () => {
  test("drops a plain img spinner", () => {
    const body = finalBody(
      `Pi is working… <img src="https://example.test/a.png" width="14px" />

${ANSWER}

[View job run](https://example.test/run/1)`,
    );

    expect(body).not.toContain("Pi is working");
    expect(body).not.toContain("<img");
    expect(body).toContain(ANSWER);
  });

  test("drops a picture element with light and dark sources", () => {
    const body = finalBody(
      `Pi is working… <picture><source media="(prefers-color-scheme: dark)" srcset="https://example.test/d.gif"><img src="https://example.test/l.gif" width="18px" height="18px"></picture>

${ANSWER}

[View job run](https://example.test/run/1)`,
    );

    expect(body).not.toContain("Pi is working");
    expect(body).not.toContain("<picture>");
    expect(body).not.toContain("<source");
    expect(body).not.toContain("mascot");
    expect(body).toContain(ANSWER);
  });

  test("drops a video marker", () => {
    const body = finalBody(
      `Pi is working… <video autoplay loop><source src="https://example.test/a.webm"></video>

${ANSWER}`,
    );

    expect(body).not.toContain("<video");
    expect(body).toContain(ANSWER);
  });

  test("keeps media that the answer itself contains", () => {
    const answer = "See this diagram:\n\n![chart](https://example.test/chart.png)";
    const body = finalBody(
      `Pi is working… <picture><img src="https://example.test/l.gif"></picture>

${answer}`,
    );

    expect(body).toContain("![chart](https://example.test/chart.png)");
  });
});
