/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { MemoryEngine } from "./memory-engine.ts";
import { attribution } from "./provenance.ts";

export function registerMemoryTools(tools: any, engine: MemoryEngine) {
  const save = async (id: string, text: string, append = false) => {
    const value = await engine.saveLocalFacts(
      id,
      text,
      undefined,
      append,
      "assistant",
    );
    return { text: value.text, chars: value.chars, max: value.max };
  };
  const textArgs = (args: any) => {
    if (
      !args ||
      typeof args.text !== "string" ||
      Object.keys(args).some((k) => k !== "text")
    )
      throw Error("仅接受text；共享事实只读，不能指定其他会话");
    return args.text;
  };
  const disposers = [
    tools.register({
      name: "remember_fact",
      description:
        "在当前会话独立事实中追加值得长期保留的稳定资料，如称呼和长期偏好；整份最多100字符。临时活动、当日安排留在会话经历，不自行写成常驻事实或督促任务。共享事实只读，满额时用edit_facts精简。",
      schema: { text: { type: "string", maxLength: 100 } },
      danger: "safe",
      run: (args: any, session: any) => {
        if (session.transientContext) throw Error("本轮含临时资料，不能写入独立事实");
        return save(session.id, textArgs(args), true);
      },
    }),
    tools.register({
      name: "edit_facts",
      description:
        "替换当前会话整份独立事实以更正、精简或删除，保留仍有效的稳定资料和用户明确要求保留的内容，不用临时安排反复覆盖。最多100字符，空文字表示清空；不可改共享事实，保存事实不等于设置提醒。",
      schema: { text: { type: "string", maxLength: 100 } },
      danger: "safe",
      run: (args: any, session: any) => {
        if (session.transientContext) throw Error("本轮含临时资料，不能写入独立事实");
        return save(session.id, textArgs(args));
      },
    }),
    tools.register({
      name: "recall_memory",
      description:
        "按关键词检索当前会话及已加入共享空间中的旧事；返回少量带来源的片段。",
      schema: { query: { type: "string", maxLength: 300 } },
      danger: "safe",
      run: async (args: any, session: any) => {
        if (
          !args ||
          typeof args.query !== "string" ||
          args.query.length > 300 ||
          Object.keys(args).some((k) => k !== "query")
        )
          throw Error("检索参数无效");
        const found = await engine.search(session.id, args.query, {
          manual: true,
          ...(session.transientContext ? { persistTrace: false } : {}),
        });
        return found.items.map((x) => ({
          id: x.id,
          kind: x.kind,
          text: x.text,
          source: x.source,
          ...attribution(x),
          ts: x.ts,
          outcome: x.outcome,
          reason: x.reason,
          ...(x.kind === "cognition" ? { uncertain: x.uncertain ?? true } : {}),
        }));
      },
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}
