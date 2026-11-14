import {createServer} from 'node:http';
export async function createApi(archive,port = 0) {
  const server = createServer(async (request,response) => {
    try {
      if (request.method !== 'GET' || !['/health','/records'].includes(request.url)) {response.writeHead(404);return response.end();}
      const body = request.url === '/health' ? {status:'ok'} : await archive.list();
      response.writeHead(200,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(body,null,2));
    } catch(error) {response.writeHead(500);response.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
