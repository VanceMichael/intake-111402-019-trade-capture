import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {behavior} from './behavior.mjs';

const fixturePath = new URL('../fixtures/source.json',import.meta.url);
export async function createSource(options = {}) {
  const fixture = JSON.parse(await readFile(options.fixture ?? fixturePath,'utf8'));
  let scenario = options.scenario ?? 'normal';
  let state = {};
  const requests = [];
  const server = createServer(async (request,response) => {
    try {
      const url = new URL(request.url,'http://127.0.0.1');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('request too large'); chunks.push(chunk); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const send = (status,data) => {response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(data));};
      if (url.pathname === '/__scenario' && request.method === 'POST') {
        if (body?.name !== 'normal' && !Object.hasOwn(fixture.cases,body?.name)) return send(400,{error:'unknown scenario'});
        scenario = body.name; state = {}; return send(200,{scenario});
      }
      if (url.pathname === '/__audit') return send(200,{scenario,state,requests});
      const entry = {method:request.method,path:decodeURIComponent(url.pathname),query:Object.fromEntries(url.searchParams),body,scenario};
      requests.push(entry);
      const special = behavior(entry,state,fixture,scenario);
      if (special) return send(special.status ?? 200,special.body);
      const overrides = fixture.cases[scenario] ?? [];
      const routes = [...overrides,...fixture.exchanges];
      const match = routes.find(route => route.method === entry.method && route.path === entry.path &&
        Object.entries(route.query).every(([key,value]) => entry.query[key] === value));
      if (!match) return send(404,{error:'unknown source resource',path:entry.path});
      if (!Object.entries(match.requires).every(([key,value]) => state[key] === value)) return send(409,{error:'source state precondition'});
      Object.assign(state,match.sets);
      send(match.status,match.body);
    } catch (error) {response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(options.port ?? 0,'127.0.0.1',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()))};
}
