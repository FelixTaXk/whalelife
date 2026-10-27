import { persona, personaSystemPrompt } from "./persona.ts";
import { safeId } from "./memory.ts";
import { createHash } from "node:crypto";
import {
  contextPolicy,
  validateContext,
  matchingHistory,
  requestUsage,
} from "./session-context.ts";
export class Sessions {
  memoryMaintenance = false;
  blockedSessions = new Set<string>();
  modelLimits = new Map<string, { value: number | null; until: number }>();
  locks = new Set<string>();
  root: string;
  config: any;
  services: any;
  constructor(root: string, config: any, services: any) {
    this.root = root;
    this.config = config;
    this.services = services;
  }
  async modelLimit(provider: any) {
    if (provider.context_window)
      return { tokens: provider.context_window, source: "configured" };
    const key = JSON.stringify([
      provider.id,
      provider.base_url,
      provider.model,
    ]);
    const cached = this.modelLimits.get(key);
    if (cached && cached.until > Date.now())
      return {
        tokens: cached.value,
        source: cached.value ? "provider" : "unknown",
      };
    let value: number | null = null;
    try {
      const result = await this.services.modelConfig?.listModels(provider.id);
      const metadata = result?.details?.find(
        (m: any) => m.id === provider.model,
      );
      value = metadata?.context_window || null;
    } catch {
      /* Unknown services can supply the limit in model settings. */
    }
    this.modelLimits.set(key, {
      value,
      until: Date.now() + (value ? 3600000 : 60000),
    });
    return { tokens: value, source: value ? "provider" : "unknown" };
  }
  async contextStatus(id: string) {
    safeId(id);
    const meta = await this.services.memory.sessionMeta(id);
    if (meta?.deleted) throw Error("此会话已删除，请新建或选择其他会话");
    const p = await persona(
      this.root,
      this.config,
      this.config.channels.web.persona,
    );
    const limit = await this.modelLimit(p.provider);
    const policy = contextPolicy(this.config.memory, meta?.context);
    const rows = await this.services.memory.readSession(id);
    const history = matchingHistory(rows, p.revision, policy.history_scope);
    const last = rows.findLast((row: any) => row.role === "assistant");
    const usage = last?.request_usage;
    const matches =
      usage &&
      last.persona_revision === p.revision &&
      usage.model_id === (p.provider.model_id || p.provider.model) &&
      usage.model === p.provider.model &&
      usage.provider_id === p.provider.id;
    return {
      id,
      name: meta?.name || null,
      policy,
      persona: p.name,
      model: {
        id: p.provider.model_id || p.provider.model,
        name: p.provider.model,
        context_window: limit.tokens,
        limit_source: limit.source,
      },
      available_messages: history.filter((row: any) => row.type === "message")
        .length,
      stored_messages: rows.filter((row: any) => row.type === "message").length,
      usage: matches
        ? {
            ...usage,
            context_window: limit.tokens,
            percent: limit.tokens
              ? (usage.used_tokens / limit.tokens) * 100
              : null,
            settings_changed:
              JSON.stringify(last.context_policy) !== JSON.stringify(policy),
          }
        : null,
    };
  }
  async updateContext(id: string, input: any) {
    safeId(id);
    if (
      this.memoryMaintenance ||
      this.blockedSessions.has(id) ||
      this.locks.has(id)
    )
      throw Error("会话正在处理，请结束后修改上下文");
    const policy = validateContext(input);
    this.blockedSessions.add(id);
    try {
      await this.services.memory.saveSessionMeta(id, { context: policy });
      return await this.contextStatus(id);
    } finally {
      this.blockedSessions.delete(id);
    }
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
    if (this.blockedSessions.has(id)) throw Error("会话维护中，请稍后重试");
    const meta = await this.services.memory.sessionMeta(id);
    if (meta?.deleted) throw Error("此会话已删除，请新建或选择其他会话");
    if (this.memoryMaintenance || this.blockedSessions.has(id))
      throw Error("会话维护中，请稍后重试");
    if (this.locks.has(id)) throw Error("该会话正在回复，请稍候");
    if (!text.trim() || text.length > 16000) throw Error("请输入 1–16000 字");
    this.locks.add(id);
    const { memory, llm, tools, logger } = this.services;
    try {
      const channel = this.config.channels.web;
      const p = await persona(this.root, this.config, channel.persona);
      if (expectedPersona && expectedPersona !== p.id)
        throw Error("当前人格已在其他窗口切换，请刷新后重试");
      const policy = contextPolicy(this.config.memory, meta?.context);
      const summaryId =
        "p_" +
        createHash("sha256")
          .update(
            id +
              ":" +
              p.revision +
              (policy.history_scope === "session" ? ":session" : ""),
          )
          .digest("hex")
          .slice(0, 40);
      const context = {
        persona_id: p.id,
        persona_name: p.name,
        persona_revision: p.revision,
        summary_id: summaryId,
        context_policy: policy,
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
      const history = matchingHistory(
        storedHistory,
        p.revision,
        policy.history_scope,
      );
      const contextReset = storedHistory.length > 0 && !history.length;
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
      const cfg = { ...this.config.memory, ...policy };
      const allFacts = policy.include_facts
        ? [...new Set<string>(await memory.readFacts())]
        : [];
      const facts = allFacts.slice(-(cfg.facts_max_lines ?? 100));
      let summary = policy.include_summary
        ? await memory.readSummary(summaryId)
        : "";
      const recent = (
        cfg.recent_lines === 0
          ? []
          : history
              .filter((x: any) => x.type === "message")
              .slice(-cfg.recent_lines)
      ).map((x: any) => ({ role: x.role, content: x.text }));
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
      let measured: any = null;
      const limit = await this.modelLimit(p.provider);
      for (let round = 0; round < 6; round++) {
        const reply = await llm.chat({
          provider: p.provider,
          messages,
          tools: session.permission === "off" ? [] : tools.list(),
          onChunk,
        });
        measured = requestUsage(reply.usage, p.provider, limit.tokens);
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
        request_usage: measured,
      });
      const count = history.filter((x: any) => x.type === "message").length + 2;
      const n = cfg.recent_lines ?? 30;
      if (policy.include_summary && n > 0 && count > n && count % 10 === 0) {
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
