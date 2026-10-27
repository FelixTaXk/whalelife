import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../core/logger.ts";
import { ModelConfig, resolveChatModel } from "../core/model-config.ts";

const { renderBindings, bindBindings } = await import(
  new URL("../core/ui/views.js", import.meta.url).href
);

async function fixture(activePersona = "whale") {
  const root = await mkdtemp(join(tmpdir(), "whale-bindings-"));
  await mkdir(join(root, "config"));
  const config: any = {
    providers: [
      {
        id: "test",
        name: "测试连接",
        protocol: "openai-compatible",
        base_url: "https://models.example/v1",
        api_key: "fixture-secret",
        enabled: true,
      },
    ],
    models: ["chat-one", "chat-two"].map((id) => ({
      id,
      name: id,
      provider: "test",
      model: id,
      type: "chat",
      enabled: true,
      parameters: {},
    })),
    model_bindings: { chat: "chat-one" },
    personas: {
      whale: {
        name: "鲸鲸",
        model: null,
        file: "memory/personas/whale.md",
        permission: "ask",
      },
      helper: {
        name: "研究助手",
        model: "chat-one",
        file: "memory/personas/helper.md",
        permission: "off",
      },
    },
    channels: {
      web: { persona: activePersona, permission: "full", keep: "web-setting" },
      local: { keep: "another-channel" },
    },
    custom: { keep: "untouched" },
  };
  const file = join(root, "config/config.json");
  await writeFile(file, JSON.stringify(config, null, 2));
  const manager = new ModelConfig(root, config, new Logger(join(root, "logs")));
  const input = () => {
    const s = manager.snapshot();
    return {
      revision: s.revision,
      providers: s.providers,
      models: s.models,
      bindings: s.bindings,
      personaModels: Object.fromEntries(s.personas.map((p) => [p.id, p.model])),
    };
  };
  return { root, file, config, manager, input };
}

test("active persona and workspace binding persist together without changing persona overrides", async () => {
  const f = await fixture();
  const edit = { ...f.input(), activePersona: "helper" };
  edit.bindings.chat = "chat-two";
  const saved = await f.manager.save(edit);
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.activePersona, "helper");
  assert.equal(saved.bindings.chat, "chat-two");
  assert.equal(disk.channels.web.persona, "helper");
  assert.equal(disk.model_bindings.chat, "chat-two");
  assert.equal(disk.channels.web.permission, "full");
  assert.equal(disk.channels.web.keep, "web-setting");
  assert.deepEqual(disk.channels.local, { keep: "another-channel" });
  assert.deepEqual(disk.custom, { keep: "untouched" });
  assert.equal(f.config.channels.web.persona, "helper");
  assert.equal(resolveChatModel(f.config, "helper").model, "chat-one");
  const restarted = new ModelConfig(
    f.root,
    disk,
    new Logger(join(f.root, "logs")),
  );
  assert.equal(restarted.snapshot().activePersona, "helper");
  assert.equal(restarted.snapshot().bindings.chat, "chat-two");
});

test("invalid active persona rejects the whole write without partially saving model bindings", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  for (const activePersona of ["missing", "", "__proto__", null, 1, []]) {
    const edit = { ...f.input(), activePersona };
    edit.bindings.chat = "chat-two";
    await assert.rejects(f.manager.save(edit), /当前人格必须选择已存在的人格/);
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.equal(f.config.channels.web.persona, "whale");
    assert.equal(f.manager.snapshot().bindings.chat, "chat-one");
  }
});

test("older model-only saves preserve the active persona when the optional field is absent", async () => {
  const f = await fixture("helper");
  const edit = f.input();
  edit.bindings.chat = "chat-two";
  assert.equal(Object.hasOwn(edit, "activePersona"), false);
  await f.manager.save(edit);
  const disk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(disk.channels.web.persona, "helper");
  assert.equal(f.manager.snapshot().activePersona, "helper");
  assert.equal(disk.model_bindings.chat, "chat-two");
});

test("a rejected model binding cannot publish the requested persona switch", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  const edit = { ...f.input(), activePersona: "helper" };
  edit.bindings.chat = "missing-model";
  await assert.rejects(f.manager.save(edit), /绑定的模型/);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.equal(f.manager.snapshot().activePersona, "whale");
});

function uiFixture() {
  return {
    state: {
      chatBusy: false,
      config: {
        revision: "revision-one",
        activePersona: "whale",
        providers: [{ id: "test", name: "测试连接", enabled: true }],
        models: ["chat-one", "chat-two"].map((id) => ({
          id,
          name: id,
          type: "chat",
          provider: "test",
          enabled: true,
        })),
        bindings: {
          chat: "chat-one",
          embedding: null,
          rerank: null,
          image: null,
          stt: null,
          tts: null,
        },
        personas: [
          { id: "whale", name: "鲸鲸", model: null },
          { id: "helper", name: "研究助手", model: "chat-one" },
        ],
      },
    },
  } as any;
}

test("bindings page shows the selected persona, dedicated-model priority, and editing entry", () => {
  const app = uiFixture();
  app.state.config.activePersona = "helper";
  app.state.config.personas[1].name = '<img src=x onerror="alert(1)">';
  const html = renderBindings(app);
  assert.match(html, /id="active-persona" name="activePersona"/);
  assert.match(html, /value="helper" selected/);
  assert.match(html, /专用模型「chat-one」优先于工作空间的对话模型/);
  assert.match(html, /href="#personas"/);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.doesNotMatch(html, /<img\b/);
  app.state.chatBusy = true;
  assert.match(renderBindings(app), /id="active-persona"[^>]*disabled/);
});

async function withBindingForm(
  app: any,
  action: (form: any, values: Map<string, string>, nodes: any) => Promise<void>,
) {
  const values = new Map<string, string>([
    ["activePersona", "whale"],
    ["binding_chat", "chat-one"],
  ]);
  const nodes: any = {
    "#active-persona": { value: "whale" },
    "#active-persona-routing": { textContent: "" },
    "[type=submit]": { disabled: false },
    "#bindings-error": { textContent: "" },
  };
  const form: any = { querySelector: (selector: string) => nodes[selector] };
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const formDataDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "FormData",
  )!;
  class TestFormData {
    get(name: string) {
      return values.get(name) ?? null;
    }
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: () => form },
  });
  Object.defineProperty(globalThis, "FormData", {
    ...formDataDescriptor,
    value: TestFormData,
  });
  app.configDraft = () => {
    const c = structuredClone(app.state.config);
    return {
      revision: c.revision,
      providers: c.providers,
      models: c.models,
      bindings: c.bindings,
      personaModels: Object.fromEntries(
        c.personas.map((p: any) => [p.id, p.model]),
      ),
    };
  };
  try {
    bindBindings(app);
    await action(form, values, nodes);
  } finally {
    if (documentDescriptor)
      Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    Object.defineProperty(globalThis, "FormData", formDataDescriptor);
  }
}

test("one bindings submit saves model and persona together then starts a new session", async () => {
  const app = uiFixture();
  const events: string[] = [];
  let saved: any;
  app.saveConfig = async (next: any) => {
    saved = next;
    events.push("save");
  };
  app.newSession = () => events.push("new-session");
  await withBindingForm(app, async (form, values, nodes) => {
    values.set("activePersona", "helper");
    values.set("binding_chat", "chat-two");
    nodes["#active-persona"].value = "helper";
    nodes["#active-persona"].onchange();
    assert.match(
      nodes["#active-persona-routing"].textContent,
      /专用模型「chat-one」优先/,
    );
    await form.onsubmit({ preventDefault() {} });
    assert.equal(nodes["#bindings-error"].textContent, "");
  });
  assert.deepEqual(events, ["save", "new-session"]);
  assert.equal(saved.activePersona, "helper");
  assert.equal(saved.bindings.chat, "chat-two");
  assert.equal(saved.personaModels.helper, "chat-one");
});

test("busy chat blocks persona changes even if a disabled selector is bypassed", async () => {
  const app = uiFixture();
  app.state.chatBusy = true;
  app.saveConfig = async () => assert.fail("busy persona switch must not save");
  app.newSession = () =>
    assert.fail("busy persona switch must not reset history");
  await withBindingForm(app, async (form, values, nodes) => {
    values.set("activePersona", "helper");
    await form.onsubmit({ preventDefault() {} });
    assert.match(nodes["#bindings-error"].textContent, /等待当前回复结束/);
    assert.equal(nodes["[type=submit]"].disabled, false);
  });
});

test("an unchanged persona or failed save never resets the current session", async () => {
  const app = uiFixture();
  let saves = 0;
  app.saveConfig = async () => {
    saves++;
  };
  app.newSession = () => assert.fail("session must be kept");
  await withBindingForm(app, async (form, values, nodes) => {
    await form.onsubmit({ preventDefault() {} });
    assert.equal(saves, 1);
    values.set("activePersona", "helper");
    app.saveConfig = async () => {
      throw Error("配置已被其他窗口修改");
    };
    await form.onsubmit({ preventDefault() {} });
    assert.match(nodes["#bindings-error"].textContent, /其他窗口修改/);
    assert.equal(nodes["[type=submit]"].disabled, false);
  });
});
