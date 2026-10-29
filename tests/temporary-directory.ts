import { after } from "node:test";
import { mkdir, mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Only directories created by this test process are eligible for cleanup.
// Never scan or remove old OS Temp directories from this helper.
const base = resolve(fileURLToPath(new URL("../.artifacts/tests/", import.meta.url)));
const owned = new Set<string>();
async function prepare() {
  await mkdir(base, { recursive: true });
  if (resolve(await realpath(base)) !== base || (await lstat(base)).isSymbolicLink())
    throw Error("Test directory must be an ordinary project-local directory");
}

export async function temporaryDirectory(prefix: string) {
  if (!/^whale-[a-z0-9-]+-$/.test(prefix)) throw Error("Invalid test directory prefix");
  await prepare();
  const directory = await mkdtemp(join(base, prefix));
  owned.add(directory); // Register before fixture setup or assertions can fail.
  return directory;
}

after(async () => {
  const errors: unknown[] = [];
  for (const directory of owned) {
    try {
      if (dirname(resolve(directory)) !== base || resolve(await realpath(base)) !== base)
        throw Error("Refusing cleanup outside the owned test root");
      try {
        if ((await lstat(directory)).isSymbolicLink()) throw Error("Test directory became a link");
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      owned.delete(directory);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Test directory cleanup failed");
});
