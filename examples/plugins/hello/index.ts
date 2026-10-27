import type { Context } from "../../../core/context.ts";
export async function apply(ctx: Context) {
  ctx.provide("hello", { greet: (name: string) => `你好，${name}` });
  ctx.tools.register({
    name: "say_hello",
    description: "当用户需要打招呼时调用，name 是对方名字",
    schema: { name: { type: "string" } },
    danger: "safe",
    async run(args: any) {
      return ctx.get("hello").greet(args.name);
    },
  });
  await ctx.plugin(await import("./sub/extra/index.ts"));
  ctx.effect(() => () => ctx.logger.info("hello 已清理"));
}
