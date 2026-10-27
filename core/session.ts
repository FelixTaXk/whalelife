import { persona } from "./persona.ts";
import { safeId } from "./memory.ts";
export class Sessions {
  locks = new Set<string>();
  root: string;
  config: any;
  services: any;
  constructor(root: string, config: any, services: any) {
    this.root = root;
    this.config = config;
    this.services = services;
  }
  async chat(id: string, text: string, onChunk: (text: string) => void) {
    safeId(id);
    if (this.locks.has(id)) throw Error("该会话正在回复，请稍候");
    if (!text.trim() || text.length > 16000) throw Error("请输入 1–16000 字");
    this.locks.add(id);
    const { memory, llm, tools, logger } = this.services;
    try {
      const channel = this.config.channels.web;
      const p = await persona(this.root, this.config, channel.persona);
      const session = {
        id,
        channel: "web",
        peer: id,
        personaId: p.id,
        permission: channel.permission ?? p.permission,
      };
      const history = await memory.readSession(id);
      await memory.appendEvent({
        type: "message",
        channel: "web",
        session: id,
        role: "user",
        text,
      });
      const cfg = this.config.memory;
      const allFacts = await memory.readFacts();
      const facts = allFacts.slice(-(cfg.facts_max_lines ?? 100));
      let summary = await memory.readSummary(id);
      const recent = history
        .filter((x: any) => x.type === "message")
        .slice(-(cfg.recent_lines ?? 30))
        .map((x: any) => ({ role: x.role, content: x.text }));
      const budget = (cfg.budget_tokens ?? 6000) * 2;
      const cost = () =>
        JSON.stringify(recent).length +
        summary.length +
        facts.join("\n").length +
        text.length;
      if (cost() > budget) summary = "";
      while (cost() > budget && recent.length) recent.shift();
      while (cost() > budget && facts.length) facts.shift();
      const messages: any[] = [
        {
          role: "system",
          content:
            p.prompt +
            "\n当用户明确要求记住事实时调用 remember_fact 工具，不要仅口头承诺。\n共享事实：\n" +
            (allFacts.length > facts.length ? "facts 已截断\n" : "") +
            facts.join("\n") +
            "\n会话摘要：\n" +
            summary,
        },
        ...recent,
        { role: "user", content: text },
      ];
      let final = "";
      for (let round = 0; round < 6; round++) {
        const reply = await llm.chat({
          provider: p.provider,
          messages,
          tools: session.permission === "off" ? [] : tools.list(),
          onChunk,
        });
        if (!reply.toolCalls.length) {
          final = reply.text;
          break;
        }
        messages.push({
          role: "assistant",
          content: reply.text || null,
          tool_calls: reply.toolCalls.map((c: any) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });
        for (const call of reply.toolCalls) {
          let result;
          try {
            result = await tools.call(
              call.name,
              JSON.parse(call.arguments),
              session,
            );
          } catch (error: any) {
            result = { ok: false, result: error.message };
          }
          await memory.appendEvent({
            type: "tool",
            channel: "web",
            session: id,
            name: call.name,
            args: call.arguments,
            ...result,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }
      if (!final) throw Error("模型未返回最终回复，请重试");
      await memory.appendEvent({
        type: "message",
        channel: "web",
        session: id,
        role: "assistant",
        text: final,
      });
      const count = history.filter((x: any) => x.type === "message").length + 2;
      const n = cfg.recent_lines ?? 30;
      if (count > n && count % 10 === 0) {
        try {
          const old = (await memory.readSession(id))
            .filter((x: any) => x.type === "message")
            .slice(0, -n)
            .slice(-10);
          const result = await llm.chat({
            provider: p.provider,
            messages: [
              {
                role: "system",
                content:
                  "将旧摘要与新增对话合并成简短会话摘要，保留事实和约定，最多500字。",
              },
              { role: "user", content: summary + "\n" + JSON.stringify(old) },
            ],
          });
          await memory.writeSummary(id, result.text);
        } catch (error) {
          logger.warn("摘要更新失败，下次重试", { error });
        }
      }
      return final;
    } finally {
      this.locks.delete(id);
    }
  }
}
