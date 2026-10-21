import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  REVIEWED_SOURCE_OMISSIONS,
  SOURCE_REVISION_OVERRIDES,
  findSourceLicenseInCheckout,
  normalizedRepositoryUrl,
  readLicenseTextsFromDirectory,
  reviewedSourceOmissionForPackage,
  sourceRevisionForPackage,
} from "./generate-cargo-licenses.js";

test("strict Cargo license recovery walks from a crate to its workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "rosi-license-test-"));
  try {
    mkdirSync(join(root, "crates", "example"), { recursive: true });
    writeFileSync(
      join(root, "LICENSE"),
      "Permission is hereby granted to use this test license.\n",
    );
    const result = findSourceLicenseInCheckout(
      { license_file: null },
      { revision: "a".repeat(40), pathInRepository: "crates/example" },
      root,
      "https://example.com/repository.git",
    );
    assert.equal(result?.directory, ".");
    assert.match(result?.text || "", /Permission is hereby granted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict Cargo license recovery distinguishes a verified omission from a missing source path", () => {
  const root = mkdtempSync(join(tmpdir(), "rosi-license-omission-test-"));
  try {
    mkdirSync(join(root, "crates", "example"), { recursive: true });
    const result = findSourceLicenseInCheckout(
      { license_file: null },
      { revision: "a".repeat(40), pathInRepository: "crates/example" },
      root,
      "https://example.com/repository.git",
    );
    assert.equal(result?.noLicenseText, true);
    assert.equal(
      findSourceLicenseInCheckout(
        { license_file: null },
        { revision: "a".repeat(40), pathInRepository: "missing" },
        root,
        "https://example.com/repository.git",
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict Cargo license recovery rejects an intermediate link outside the checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "rosi-license-link-test-"));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  try {
    mkdirSync(checkout);
    mkdirSync(join(outside, "pkg"), { recursive: true });
    writeFileSync(join(outside, "LICENSE"), "outside checkout license\n");
    symlinkSync(
      outside,
      join(checkout, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      findSourceLicenseInCheckout(
        { license_file: null },
        { revision: "a".repeat(40), pathInRepository: "linked/pkg" },
        checkout,
        "https://example.com/repository.git",
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declared license files cannot escape through an intermediate link", () => {
  const root = mkdtempSync(join(tmpdir(), "rosi-license-file-link-test-"));
  const packageDir = join(root, "package");
  const outside = join(root, "outside");
  try {
    mkdirSync(packageDir);
    mkdirSync(outside);
    writeFileSync(join(outside, "LICENSE"), "outside package license\n");
    symlinkSync(
      outside,
      join(packageDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      readLicenseTextsFromDirectory(packageDir, "linked/LICENSE"),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source recovery accepts only credential-free HTTPS repositories", () => {
  assert.equal(
    normalizedRepositoryUrl("git+https://github.com/example/repo.git#main"),
    "https://github.com/example/repo.git",
  );
  assert.equal(normalizedRepositoryUrl("http://example.com/repo.git"), null);
  assert.equal(
    normalizedRepositoryUrl("https://user@example.com/repo.git"),
    null,
  );
});

test("license recovery recognizes British LICENCE filenames", () => {
  const root = mkdtempSync(join(tmpdir(), "rosi-licence-test-"));
  try {
    writeFileSync(
      join(root, "LICENCE"),
      "Permission is hereby granted to use this test license.\n",
    );
    assert.match(
      readLicenseTextsFromDirectory(root) || "",
      /--- LICENCE ---[\s\S]*Permission is hereby granted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("license recovery uses only pinned source revisions for omitted VCS metadata", () => {
  const revision = sourceRevisionForPackage({
    name: "rustls-platform-verifier-android",
    version: "0.1.1",
    repository: "https://github.com/rustls/rustls-platform-verifier",
  });
  assert.deepEqual(
    revision,
    SOURCE_REVISION_OVERRIDES.get("rustls-platform-verifier-android@0.1.1"),
  );
  assert.equal(
    sourceRevisionForPackage({ name: "unknown", version: "1.0.0" }),
    null,
  );
});

test("source-only license omissions are explicit and package-version scoped", () => {
  const reason = reviewedSourceOmissionForPackage({
    name: "selectors",
    version: "0.36.1",
  });
  assert.equal(reason, REVIEWED_SOURCE_OMISSIONS.get("selectors@0.36.1"));
  assert.equal(
    reviewedSourceOmissionForPackage({ name: "selectors", version: "0.36.2" }),
    null,
  );
  assert.equal(
    reviewedSourceOmissionForPackage({ name: "sigchld", version: "0.2.5" }),
    REVIEWED_SOURCE_OMISSIONS.get("sigchld@0.2.5"),
  );
  assert.equal(
    reviewedSourceOmissionForPackage({ name: "sigchld", version: "0.2.6" }),
    null,
  );
});
