import { decision } from './permission.ts';
import type { Logger } from './logger.ts';
export class Tools {
  entries=new Map<string,any>(); logger:Logger; overrides:any;
  constructor(logger:Logger,overrides:any={remember_fact:'full'}){this.logger=logger;this.overrides=overrides}
  register(tool:any){if(this.entries.has(tool.name))throw Error('工具重名：'+tool.name);this.entries.set(tool.name,tool);return ()=>{this.entries.delete(tool.name)}}
  list(){return [...this.entries.values()].map(({name,description,schema})=>({type:'function',function:{name,description,parameters:schema.type?schema:{type:'object',properties:schema,required:Object.keys(schema),additionalProperties:false}}}))}
  async call(name:string,args:any,session:any){const tool=this.entries.get(name);try{if(!tool)throw Error('工具不存在');const verdict=decision(session.permission,tool.danger??'ask',this.overrides[name]);this.logger.info('工具权限判定',{name,verdict,args:JSON.stringify(args).slice(0,120)});if(verdict!=='allow')throw Error(verdict==='ask'?'需要审批；M0 暂不支持审批，请修改权限后重启':'工具已关闭');const result=await tool.run(args,session);return {ok:true,result}}catch(error:any){this.logger.error('工具调用失败',{name,error});return {ok:false,result:error.message}}}
}
