import assert from "node:assert/strict";
import test from "node:test";
import { STABLE_MIN_BETA_SOAK_DAYS } from "./release-policy.cjs";
import {
  assertStableBetaSoak,
  expectedReleaseBranch,
  newestBetaTag,
  readLocalBetaTags,
  tagDateFromRecord,
} from "./release-preflight.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-30T12:00:00Z");

function daysBefore(days, from = NOW) {
  return new Date(from.getTime() - days * DAY_MS);
}

function tagsAt(date, names = ["v5.0.0-beta.1"]) {
  return names.map((name) => ({ name, date }));
}

function assertThrowsMatching(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.match(String(error.message), pattern);
    return true;
  });
}

test("stable soak constant is 14 days", () => {
  assert.equal(STABLE_MIN_BETA_SOAK_DAYS, 14);
});

test("beta and stable versions still map to their release branches", () => {
  assert.equal(expectedReleaseBranch("5.0.0-beta.4"), "beta");
  assert.equal(expectedReleaseBranch("5.0.0"), "main");
  assert.throws(() => expectedReleaseBranch("5.0.0-rc.1"));
});

test("annotated tags use the tagger date, not the commit date", () => {
  const tagger = 1790000000;
  const commit = 1780000000;
  const date = tagDateFromRecord({
    objectType: "tag",
    taggerUnix: String(tagger),
    commitUnix: String(commit),
  });
  assert.equal(date.getTime(), tagger * 1000);
});

test("annotated tags without a tagger date fall back to the commit date", () => {
  const date = tagDateFromRecord({
    objectType: "tag",
    taggerUnix: "",
    commitUnix: "1780000000",
  });
  assert.equal(date.getTime(), 1780000000 * 1000);
});

test("lightweight tags use the commit date", () => {
  const date = tagDateFromRecord({
    objectType: "commit",
    taggerUnix: "",
    commitUnix: "1790921931",
  });
  assert.equal(date.getTime(), 1790921931 * 1000);
});

test("missing, empty, or non-numeric tag dates are rejected as null", () => {
  assert.equal(
    tagDateFromRecord({ objectType: "commit", taggerUnix: "", commitUnix: "" }),
    null,
  );
  assert.equal(
    tagDateFromRecord({
      objectType: "commit",
      taggerUnix: "",
      commitUnix: undefined,
    }),
    null,
  );
  assert.equal(
    tagDateFromRecord({
      objectType: "commit",
      taggerUnix: "",
      commitUnix: "abc",
    }),
    null,
  );
});

test("newest beta tag is the highest beta number for the stable base", () => {
  const picked = newestBetaTag("5.0.0", [
    { name: "v5.0.0-beta.2", date: daysBefore(20) },
    { name: "v5.0.0-beta.10", date: daysBefore(3) },
    { name: "v5.0.0-beta.3", date: daysBefore(15) },
  ]);
  assert.equal(picked.name, "v5.0.0-beta.10");
  assert.equal(picked.beta, 10);
});

test("newest beta tag does not depend on input order", () => {
  const forward = [
    { name: "v5.0.0-beta.1", date: daysBefore(30) },
    { name: "v5.0.0-beta.2", date: daysBefore(20) },
  ];
  const backward = [...forward].reverse();
  assert.deepEqual(
    newestBetaTag("5.0.0", forward),
    newestBetaTag("5.0.0", backward),
  );
});

test("newest beta tag ignores other base versions and malformed names", () => {
  const picked = newestBetaTag("5.0.0", [
    { name: "v5.0.1-beta.9", date: daysBefore(1) },
    { name: "v5.0.0-beta", date: daysBefore(1) },
    { name: "v5.0.0-beta.01", date: daysBefore(1) },
    { name: "v5.0.0-beta.1.2", date: daysBefore(1) },
    { name: "v5.0.0-beta.x", date: daysBefore(1) },
    { name: "v5.0.0-rc.1", date: daysBefore(1) },
    { name: "v5.0.0-beta.2", date: daysBefore(16) },
  ]);
  assert.equal(picked.name, "v5.0.0-beta.2");
});

test("newest beta tag is null when no tag matches the stable base", () => {
  assert.equal(
    newestBetaTag("5.0.0", [{ name: "v5.0.1-beta.1", date: NOW }]),
    null,
  );
  assert.equal(newestBetaTag("5.0.0", []), null);
});

test("readLocalBetaTags parses for-each-ref output into dated records", () => {
  const seen = [];
  const runGit = (args) => {
    seen.push(args);
    return [
      "v5.0.0-beta.1|commit||1790921931|1790921931",
      "v5.0.0-beta.2|tag|1791864481|1791800000|1791800000",
      "",
    ].join("\n");
  };
  const records = readLocalBetaTags("5.0.0", runGit);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 1), ["for-each-ref"]);
  assert.ok(seen[0].includes("refs/tags/v5.0.0-beta.*"));
  assert.deepEqual(
    records.map((record) => [record.name, record.date.getTime()]),
    [
      ["v5.0.0-beta.1", 1790921931 * 1000],
      ["v5.0.0-beta.2", 1791864481 * 1000],
    ],
  );
});

test("readLocalBetaTags reports a missing date as null instead of guessing", () => {
  const records = readLocalBetaTags("5.0.0", () => "v5.0.0-beta.1|commit|||\n");
  assert.equal(records[0].date, null);
});

test("readLocalBetaTags propagates git failures", () => {
  assert.throws(
    () =>
      readLocalBetaTags("5.0.0", () => {
        throw new Error("fatal: not a git repository");
      }),
    /not a git repository/,
  );
});

test("soak passes when the newest beta is exactly 14 days old", () => {
  const result = assertStableBetaSoak({
    version: "5.0.0",
    now: NOW,
    listBetaTags: () =>
      tagsAt(daysBefore(STABLE_MIN_BETA_SOAK_DAYS), ["v5.0.0-beta.3"]),
  });
  assert.equal(result.tag, "v5.0.0-beta.3");
  assert.ok(Math.abs(result.ageDays - 14) < 1e-9);
});

test("soak passes when the newest beta is older than 14 days", () => {
  const result = assertStableBetaSoak({
    version: "5.0.0",
    now: NOW,
    listBetaTags: () => tagsAt(daysBefore(60)),
  });
  assert.equal(result.tag, "v5.0.0-beta.1");
});

test("soak fails one millisecond short of 14 days and reports the wait", () => {
  const justShort = new Date(
    NOW.getTime() - STABLE_MIN_BETA_SOAK_DAYS * DAY_MS + 1,
  );
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => tagsAt(justShort),
      }),
    /at least 14 days old.*Wait 1 more day/s,
  );
});

test("soak fails when the newest beta is a few days old", () => {
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => tagsAt(daysBefore(3), ["v5.0.0-beta.4"]),
      }),
    /v5\.0\.0-beta\.4.*3 days old/s,
  );
});

test("soak fails when the tag is dated in the future", () => {
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => tagsAt(new Date(NOW.getTime() + DAY_MS)),
      }),
    /future/,
  );
});

test("soak fails when the tag is dated exactly now", () => {
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => tagsAt(NOW),
      }),
    /at least 14 days/,
  );
});

test("soak fails with a fetch hint when no beta tag exists for the stable base", () => {
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => [],
      }),
    /No local tag|none found|git fetch --tags origin/,
  );
});

test("soak fails when the newest beta tag has no readable date", () => {
  assertThrowsMatching(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => [{ name: "v5.0.0-beta.2", date: null }],
      }),
    /Could not read the date of v5\.0\.0-beta\.2/,
  );
});

test("soak fails closed when the clock value is not a valid date", () => {
  assert.throws(() =>
    assertStableBetaSoak({
      version: "5.0.0",
      now: new Date("not a date"),
      listBetaTags: () => tagsAt(daysBefore(60)),
    }),
  );
  assert.throws(() =>
    assertStableBetaSoak({
      version: "5.0.0",
      now: "2026-11-30",
      listBetaTags: () => tagsAt(daysBefore(60)),
    }),
  );
});

test("soak refuses to run for beta or malformed versions", () => {
  for (const version of ["5.0.0-beta.4", "5.0.0-rc.1", "5.0", "v5.0.0"]) {
    assert.throws(
      () =>
        assertStableBetaSoak({
          version,
          now: NOW,
          listBetaTags: () => tagsAt(daysBefore(60)),
        }),
      /stable/,
      version,
    );
  }
});

test("soak lookup failures propagate instead of passing", () => {
  assert.throws(
    () =>
      assertStableBetaSoak({
        version: "5.0.0",
        now: NOW,
        listBetaTags: () => {
          throw new Error("git unavailable");
        },
      }),
    /git unavailable/,
  );
});

test("soak uses the default git reader when no lookup is injected", () => {
  // The default reader runs against this repository; only assert that the
  // call shape is accepted and failures are reported, not that the tag exists.
  assert.throws(
    () => assertStableBetaSoak({ version: "99.0.0", now: NOW }),
    /99\.0\.0/,
  );
});
