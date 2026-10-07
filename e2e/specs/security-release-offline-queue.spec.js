import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { api, waitForAppReady } from "../helpers/app-bridge.js";

const resultPath = process.env.ROSI_OFFLINE_QUEUE_RESULTS;
const expectedId = "offline-dns-queue";
const expectedUrl = "http://offline-repair.invalid/video.mp4";

describe("offline persisted queue recovery", () => {
  before(async () => {
    assert.ok(resultPath, "ROSI_OFFLINE_QUEUE_RESULTS is required");
    await waitForAppReady();
  });

  it("retains a public syntactic URL when startup DNS is unavailable", async () => {
    const queue = await api("getQueue");
    const item = Array.isArray(queue)
      ? queue.find((candidate) => candidate.id === expectedId)
      : null;
    const passed =
      item?.url === expectedUrl &&
      item.status === "pending" &&
      item.completedAt == null;
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify(
        [
          {
            name: "persisted-offline-queue",
            status: passed ? "passed" : "failed",
            observed: item ?? null,
            invariantPassed: passed,
          },
        ],
        null,
        2,
      )}\n`,
    );
    assert.equal(
      item?.url,
      expectedUrl,
      `startup dropped or changed the persisted offline URL: ${JSON.stringify(queue)}`,
    );
    assert.equal(item.status, "pending");
    const cleared = await api("clearQueue");
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
  });
});
