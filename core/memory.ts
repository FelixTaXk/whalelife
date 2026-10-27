import { mkdir, readFile, appendFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger.ts';
export const safeId = (id:string) => {if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('会话 ID 无效'); return id;};
export async function atomic(file:string,data:string){const temp=file+'.tmp';await writeFile(temp,data,'utf8');await rename(temp,file)}
export class Memory {
  root:string; logger:Logger; queue:Promise<any> = Promise.resolve();
  constructor(root:string,logger:Logger){this.root=root;this.logger=logger}
  async init(){for(const dir of ['sessions','summaries','personas']) await mkdir(join(this.root,dir),{recursive:true});try{await writeFile(join(this.root,'facts.md'),'# facts\n',{flag:'wx'})}catch(e:any){if(e.code!=='EEXIST') throw e}this.logger.info('记忆就绪',{root:this.root})}
  serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next}
  async readFacts(){return (await readFile(join(this.root,'facts.md'),'utf8')).split(/\r?\n/).filter(x=>x.trim()&&!x.startsWith('#'))}
  writeFacts(lines:string[]){return this.serial(()=>atomic(join(this.root,'facts.md'),'# facts\n'+lines.join('\n')+'\n'))}
  addFact(text:string){return this.serial(async()=>{text=text.replace(/[\r\n]+/g,' ').trim();if(!text||text.startsWith('#')||text.length>2000)throw Error('事实不能为空或超过 2000 字');await appendFile(join(this.root,'facts.md'),text+'\n');this.logger.info('记忆事实追加',{file:'facts.md',count:1});return '已记下：'+text})}
  async readSession(id:string,limit=Infinity){const file=join(this.root,'sessions',safeId(id)+'.jsonl');let raw;try{raw=await readFile(file,'utf8')}catch(e:any){if(e.code==='ENOENT')return [];throw e}const lines=raw.split('\n');const result:any[]=[];for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{result.push(JSON.parse(lines[i]))}catch{if(i!==lines.length-1)throw Error('JSONL 中间行损坏：'+file);this.logger.warn('忽略 JSONL 最后半行',{file})}}return result.slice(-limit)}
  appendEvent(line:any){return this.serial(async()=>{const file=join(this.root,'sessions',safeId(line.session)+'.jsonl');let raw='';try{raw=await readFile(file,'utf8')}catch(e:any){if(e.code!=='ENOENT')throw e}if(raw&&!raw.endsWith('\n')){try{JSON.parse(raw.slice(raw.lastIndexOf('\n')+1));await appendFile(file,'\n')}catch{await atomic(file,raw.slice(0,raw.lastIndexOf('\n')+1));this.logger.warn('修复 JSONL 尾部',{file})}}await appendFile(file,JSON.stringify({ts:new Date().toISOString(),...line})+'\n');let index:any={version:1,sessions:{}};try{index=JSON.parse(await readFile(join(this.root,'index.json'),'utf8'))}catch{}index.sessions[line.session]={file:`sessions/${line.session}.jsonl`,updatedAt:new Date().toISOString()};await atomic(join(this.root,'index.json'),JSON.stringify(index,null,2));this.logger.info('记忆写入',{file,count:1})})}
  writeSummary(id:string,md:string){return this.serial(()=>atomic(join(this.root,'summaries',safeId(id)+'.md'),md))}
  async readSummary(id:string){try{return await readFile(join(this.root,'summaries',safeId(id)+'.md'),'utf8')}catch(e:any){if(e.code==='ENOENT')return '';throw e}}
  async status(){const files=await readdir(join(this.root,'sessions'));const stats=await Promise.all(files.map(f=>stat(join(this.root,'sessions',f))));return {files:files.length,bytes:stats.reduce((n,s)=>n+s.size,0),updatedAt:new Date().toISOString()}}
}
