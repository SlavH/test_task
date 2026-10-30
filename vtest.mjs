import handler from './src/server.mjs';
import http from 'node:http';
const server = http.createServer((req,res)=>handler(req,res));
server.listen(0,'127.0.0.1',async()=>{
  const base=`http://127.0.0.1:${server.address().port}`;
  const r=await fetch(base+'/healthz');
  console.log('health', r.status, await r.text());
  server.close();
});
