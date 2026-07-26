import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asBehavior, simErrors } from "../behaviors.js";
import { DOOR_PROFILES } from "../doors.js";
import { parseSse, sseText } from "../sse.js";

describe("routekit-testkit", () => {
  it("exposes door profiles", () => {
    assert.ok(DOOR_PROFILES.length >= 3);
    assert.ok(DOOR_PROFILES.some((d) => d.id === "openai-chat"));
  });

  it("normalizes string behaviors", () => {
    assert.deepEqual(asBehavior("hi"), { reply: "hi" });
    assert.equal(simErrors.rateLimited().status, 429);
  });

  it("parses SSE text frames", () => {
    const frames = parseSse(
      'data: {"choices":[{"delta":{"content":"ab"}}]}\n\ndata: [DONE]\n\n'
    );
    assert.ok(frames.length >= 1);
    assert.equal(typeof sseText(frames), "string");
  });
});
