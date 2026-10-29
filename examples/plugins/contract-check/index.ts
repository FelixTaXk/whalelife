import type { Context } from "whalelife";

export async function apply(ctx: Context) {
  const base = "/plugins/contract-check/";
  const notices: any[] = [];
  for (const event of ["whalelife/ready", "channel/message", "channel/reply", "tool/called", "memory/updated"])
    ctx.on(event, (payload) => { notices.push({ event, payload }); if (notices.length > 100) notices.shift(); });
  const json = (res: any, value: any) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value)); };
  ctx.web.page(base + "settings", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>插件设置示例</title><style>body{margin:0;padding:28px;background:white;color:#202332;font:15px system-ui,sans-serif}form{max-width:620px}.form-field{display:grid;gap:8px;margin-bottom:20px}input,select,button{font:inherit;padding:10px;border:1px solid #d8dbe5;border-radius:8px}button{background:#6356df;color:white;cursor:pointer}</style><h2>插件设置示例</h2><p>此页面由插件提供，入口由主干自动展示。</p><form id="settings"><label class="form-field"><span>名称</span><input id="label" maxlength="80" placeholder="给插件起个名字"></label><label class="form-field"><span>对话模型</span><select id="model"><option value="">请选择模型</option></select></label><button class="btn primary" type="submit">保存设置</button><p id="result" role="status"></p></form><script src="${base}settings.js"></script></html>`);
  }, { title: "插件契约验收", settings: true, navigation: true });
  ctx.web.page(base + "settings.js", (_req, res) => {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(`const api=async(body)=>{const r=await fetch('${base}config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v};const form=document.querySelector('#settings'),result=document.querySelector('#result');api({action:'read'}).then(v=>{document.querySelector('#label').value=v.config.label||'';for(const m of v.models){const o=new Option(m.name,m.id);document.querySelector('#model').add(o)}document.querySelector('#model').value=v.config.model||''}).catch(e=>result.textContent=e.message);form.onsubmit=async(e)=>{e.preventDefault();try{await api({action:'save',label:document.querySelector('#label').value,model:document.querySelector('#model').value});result.textContent='已保存'}catch(e){result.textContent=e.message}};`);
  });
  ctx.web.api(base + "config", async (req, res, { signal }) => {
    let body = "";
    for await (const part of req) { body += part; if (Buffer.byteLength(body) > 4096) throw Error("请求过大"); }
    signal.throwIfAborted();
    const input = JSON.parse(body || "{}");
    if (input.action === "save") {
      if (typeof input.label !== "string" || input.label.length > 80) throw Error("名称最长80字");
      if (input.model && !ctx.models.list("chat").some((m) => m.id === input.model)) throw Error("模型不可用");
      await ctx.config.save("config.json", { label: input.label, model: input.model || null });
    } else if (input.action !== "read") throw Error("操作无效");
    json(res, { config: await ctx.config.read(), models: ctx.models.list("chat") });
  });
  ctx.tools.register({ name: "contract_echo", description: "验收专用：返回传入的文字。", schema: { text: { type: "string" } }, danger: "safe",
    origin: { platform: "契约验收", action: "回显文字" }, run: async (args: any) => args.text });
  // Test harness observes public facades. This service is not needed by real plugins.
  ctx.provide("contract-check", { ctx, notices });
}
