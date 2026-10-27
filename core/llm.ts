import type { Logger } from './logger.ts';
export class LLM {
  logger:Logger;
  constructor(logger:Logger){this.logger=logger}
  async chat(opts:any){const start=Date.now();this.logger.info('LLM 请求',{model:opts.provider.model});try{
    const response=await fetch(opts.provider.base_url.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+opts.provider.api_key,'Content-Type':'application/json'},body:JSON.stringify({model:opts.provider.model,messages:opts.messages,stream:true,stream_options:{include_usage:true},...(opts.tools?.length?{tools:opts.tools}:{})}),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(`模型服务返回 HTTP ${response.status}`);if(!response.body)throw Error('模型返回空响应');let buffer='',text='',usage:any;const calls:any[]=[];const decoder=new TextDecoder();let done=false;
    const consume=(line:string)=>{if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(data==='[DONE]'){done=true;return}if(!data)return;const obj=JSON.parse(data);if(obj.error)throw Error('模型服务返回错误');usage=obj.usage??usage;const delta=obj.choices?.[0]?.delta;if(delta?.content){text+=delta.content;opts.onChunk?.(delta.content)}for(const c of delta?.tool_calls??[]){const item=calls[c.index]??={id:'',name:'',arguments:''};if(c.id)item.id=c.id;if(c.function?.name)item.name+=c.function.name;if(c.function?.arguments)item.arguments+=c.function.arguments}};
    for await (const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});let pos;while((pos=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,pos).trim());buffer=buffer.slice(pos+1)}}buffer+=decoder.decode();if(buffer.trim())consume(buffer.trim());if(!done)throw Error('模型流意外中断');this.logger.info('LLM 完成',{model:opts.provider.model,ms:Date.now()-start,usage});return {text,toolCalls:calls.filter(Boolean),usage};
  }catch(error){this.logger.error('LLM 请求失败',{error,ms:Date.now()-start});throw error}}
}
