import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:http',()=>({request:vi.fn((_options,callback)=>{
  const request=Object.assign(new EventEmitter(),{end:()=>{
    const response=Object.assign(new EventEmitter(),{statusCode:_options.method==='POST'?409:204});
    callback(response);queueMicrotask(()=>response.emit('end'));
  },destroy:vi.fn()});return request;
})}));
import { request } from 'node:http';
import { GroupDockerEngine } from './group-container.js';
afterEach(()=>vi.restoreAllMocks());
it.each([['exited',0,true],['running',123,false],['exited',undefined,false]] as const)('reconciles kill409 only with exact exited/Pid0 (%s/%s)',async(status,pid,closed)=>{
  const engine=new GroupDockerEngine('/var/run/docker.sock'), id='a'.repeat(64),scope='synthetic-owned-scope';
  const inspect=vi.spyOn(engine,'inspect').mockResolvedValueOnce({State:{Running:true,Status:'running',Pid:123}} as never).mockResolvedValue({State:{Running:status==='running',Status:status,Pid:pid}} as never);
  vi.mocked(request).mockClear();
  if(closed)await engine.stop(id,scope);else await expect(engine.stop(id,scope)).rejects.toThrow();
  expect(inspect.mock.calls.every(([container,context])=>container===id&&context===scope)).toBe(true);
  expect(vi.mocked(request).mock.calls.some(([options])=>(options as {method:string}).method==='DELETE')).toBe(closed);
});
