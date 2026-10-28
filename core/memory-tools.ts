import type { MemoryEngine } from "./memory-engine.ts";

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
        "在当前会话独立事实中追加简短事实；整份最多100字符。共享事实只读，满额时用edit_facts精简。",
      schema: { text: { type: "string", maxLength: 100 } },
      danger: "safe",
      run: (args: any, session: any) => save(session.id, textArgs(args), true),
    }),
    tools.register({
      name: "edit_facts",
      description:
        "替换当前会话整份独立事实以更正、精简或删除。最多100字符，空文字表示清空；不可改共享事实。",
      schema: { text: { type: "string", maxLength: 100 } },
      danger: "safe",
      run: (args: any, session: any) => save(session.id, textArgs(args)),
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
        });
        return found.items.map((x) => ({
          id: x.id,
          kind: x.kind,
          text: x.text,
          source: x.source,
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
