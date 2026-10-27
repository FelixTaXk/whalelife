import { persona, personaSystemPrompt } from "./persona.ts";
import { safeId } from "./memory.ts";
import { createHash } from "node:crypto";
export class Sessions {
  memoryMaintenance = false;
  locks = new Set<string>();
  root: string;
  config: any;
  services: any;
  constructor(root: string, config: any, services: any) {
    this.root = root;
    this.config = config;
    this.services = services;
  }
  async chat(
    id: string,
    text: string,
    onChunk: (text: string) => void,
    onContext?: (value: any) => void,
    expectedPersona?: string,
  ) {
    if (this.memoryMaintenance) throw Error("记忆恢复中，请稍后重试");
    safeId(id);
    if (this.locks.has(id)) throw Error("该会话正在回复，请稍候");
    if (!text.trim() || text.length > 16000) throw Error("请输入 1–16000 字");
    this.locks.add(id);
    const { memory, llm, tools, logger } = this.services;
    try {
      const channel = this.config.channels.web;
      const p = await persona(this.root, this.config, channel.persona);
      if (expectedPersona && expectedPersona !== p.id)
        throw Error("当前人格已在其他窗口切换，请刷新后重试");
      const context = {
        persona_id: p.id,
        persona_name: p.name,
        persona_revision: p.revision,
      };
      const session = {
        id,
        channel: "web",
        peer: id,
        personaId: p.id,
        permission: channel.permission ?? p.permission,
      };
      const storedHistory = await memory.readSession(id);
      // Only the final contiguous segment belongs to the current persona version.
      let boundary = storedHistory.length - 1;
      while (
        boundary >= 0 &&
        storedHistory[boundary].persona_revision === p.revision
      )
        boundary--;
      const history = storedHistory.slice(boundary + 1);
      const contextReset =
        storedHistory.length > 0 && boundary >= 0 && !history.length;
      const summaryId =
        "p_" +
        createHash("sha256")
          .update(id + ":" + p.revision)
          .digest("hex")
          .slice(0, 40);
      if (contextReset) await memory.writeSummary(summaryId, "");
      onContext?.({ personaId: p.id, personaName: p.name, contextReset });
      logger.info("对话人格", {
        persona: p.id,
        revision: p.revision.slice(0, 12),
        contextReset,
      });
      await memory.appendEvent({
        type: "message",
        channel: "web",
        session: id,
        role: "user",
        text,
        ...context,
      });
      const cfg = this.config.memory;
      const allFacts = [...new Set<string>(await memory.readFacts())];
      const facts = allFacts.slice(-(cfg.facts_max_lines ?? 100));
      let summary = await memory.readSummary(summaryId);
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
          content: personaSystemPrompt(p, facts, summary),
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
            ...context,
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
        ...context,
      });
      const count = history.filter((x: any) => x.type === "message").length + 2;
      const n = cfg.recent_lines ?? 30;
      if (count > n && count % 10 === 0) {
        try {
          const old = [
            ...history,
            { type: "message", role: "user", text },
            { type: "message", role: "assistant", text: final },
          ]
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
          await memory.writeSummary(summaryId, result.text);
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
