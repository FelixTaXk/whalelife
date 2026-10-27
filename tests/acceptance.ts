// Manual acceptance: uses configured provider and an isolated local test profile.
// Run with the project's Node 24. Evidence stays in ignored docs/.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { boot } from "../core/index.ts";
const root = resolve(".");
const evidence = join(root, "docs/acceptance");
await mkdir(evidence, { recursive: true });
const results: any[] = [];
const login = async (port: number) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
};
const talk = (port: number, cookie: string, session: string, text: string) =>
  new Promise<any>((resolve, reject) => {
    const chunks: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, {
      headers: { Cookie: cookie },
    });
    const timer = setTimeout(() => {
      ws.close();
      reject(Error("timeout"));
    }, 180000);
    ws.on("open", () => ws.send(JSON.stringify({ session, text })));
    ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.type === "chunk") chunks.push(d.text);
      else {
        clearTimeout(timer);
        ws.close();
        resolve({
          type: d.type,
          text: chunks.join(""),
          chunks: chunks.length,
          error: d.error,
        });
      }
    });
    ws.on("error", reject);
  });
const port = 9270,
  cookie = await login(port);
const status = await (
  await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { Cookie: cookie },
  })
).json();
assert.equal(status.core, "running");
results.push({ item: 2, status: "PASS", detail: status });
const session = "acceptance_" + Date.now();
const normal = await talk(
  port,
  cookie,
  session,
  "你好，请用一句话介绍你自己。",
);
assert.equal(normal.type, "done");
assert.ok(normal.chunks > 1);
results.push({ item: 3, status: "PASS", ...normal });
const config = JSON.parse(
  await readFile(join(root, "config/config.json"), "utf8"),
);
const memoryRoot = resolve(root, config.memory.root);
const lines = (
  await readFile(join(memoryRoot, "sessions", session + ".jsonl"), "utf8")
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(lines.length, 2);
results.push({ item: 4, status: "PASS", rows: lines.length });
// Explicitly synthetic marker, not user personal data.
const fact = "验收测试：鲸鲸的测试口令是鲸蓝9270（测试数据，可删除）";
const remember = await talk(
  port,
  cookie,
  session,
  "请调用记忆工具记下这个：" + fact,
);
assert.equal(remember.type, "done");
assert.match(await readFile(join(memoryRoot, "facts.md"), "utf8"), /鲸蓝9270/);
const recall = await talk(
  port,
  cookie,
  "recall_" + Date.now(),
  "共享事实中，鲸鲸的测试口令是什么？",
);
assert.match(recall.text, /鲸蓝9270/);
results.push({ item: 5, status: "PASS", remember, recall });
const profile = await mkdtemp(join(tmpdir(), "whale-acceptance-"));
await mkdir(join(profile, "config"));
const changed = structuredClone(config);
changed.web = { host: "127.0.0.1", port: 19270 };
changed.memory.root = join(profile, "memory");
changed.channels.web.permission = "off";
changed.personas.whale.name = "重启验收人格";
changed.personas.whale.file = "memory/personas/changed.md";
changed.providers[0].model = "acceptance-model";
changed.providers[0].api_key = "deliberately-invalid-key";
await writeFile(join(profile, "config/config.json"), JSON.stringify(changed));
let app = await boot(profile);
assert.equal(app.config.providers[0].model, "acceptance-model");
assert.equal(app.config.channels.web.permission, "off");
assert.match(
  await readFile(join(profile, "memory/personas/changed.md"), "utf8"),
  /重启验收人格/,
);
await app.close();
changed.providers[0].model = config.providers[0].model;
await writeFile(join(profile, "config/config.json"), JSON.stringify(changed));
app = await boot(profile);
results.push({
  item: 6,
  status: "PASS",
  detail: "隔离配置重启：模型、人格文件与权限生效",
});
const badCookie = await login(19270);
const bad = await talk(19270, badCookie, "bad_key", "你好");
assert.equal(bad.type, "error");
assert.match(bad.error, /HTTP 401/);
const logs = await (
  await fetch("http://127.0.0.1:19270/api/logs", {
    headers: { Cookie: badCookie },
  })
).json();
assert.ok(logs.some((l: string) => l.includes("LLM 请求失败")));
assert.ok(!logs.join("").includes("deliberately-invalid-key"));
results.push({ item: 8, status: "PASS", ...bad });
await app.close();
await writeFile(
  join(evidence, "integration.json"),
  JSON.stringify(results, null, 2),
);
console.log("ACCEPTANCE RESULTS", JSON.stringify(results, null, 2));
