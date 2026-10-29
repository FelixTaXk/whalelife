import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { temporaryDirectory } from "./temporary-directory.ts";

for (const fail of [false, true]) test(`test directories are removed after ${fail ? "failed" : "successful"} assertions`, async () => {
  const root = await temporaryDirectory("whale-cleanup-verification-");
  const report = join(root, "created.json"), fixture = join(root, "fixture.test.mjs");
  await writeFile(fixture, `
    import { test } from 'node:test';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { temporaryDirectory } from ${JSON.stringify(new URL("./temporary-directory.ts", import.meta.url).href)};
    test('synthetic fixture', async () => {
      const root = await temporaryDirectory('whale-cleanup-child-');
      await writeFile(${JSON.stringify(report)}, JSON.stringify(root));
      await writeFile(join(root, 'dummy.json'), '{}');
      ${fail ? "throw Error('intentional fixture failure');" : ""}
    });
  `);
  let exitCode = 0;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try { await promisify(execFile)(process.execPath, ["--test", fixture], { env }); }
  catch (error: any) { exitCode = error.code; }
  assert.equal(exitCode, fail ? 1 : 0);
  const created = JSON.parse(await readFile(report, "utf8"));
  await assert.rejects(access(created), { code: "ENOENT" });
});

test("test directory names cannot escape the managed project directory", async () => {
  for (const prefix of ["../whale-", "C:/whale-", "whale-../", ""]) {
    await assert.rejects(temporaryDirectory(prefix), /Invalid test directory prefix/);
  }
});
