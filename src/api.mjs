import {createServer} from 'node:http';

// archive 提供 GET /records 原件归档；intake 可选，提供传输/业务/更正三层状态。
// 未接入 intake 时不伪造状态：/status 返回 404，而不是把未知状态报成成功。
export async function createApi(archive, port = 0, intake = null) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' || !['/health', '/records', '/status'].includes(url.pathname)) {
        response.writeHead(404);
        return response.end();
      }
      if (url.pathname === '/status' && !intake) {
        response.writeHead(404, {'content-type': 'application/json; charset=utf-8'});
        return response.end(JSON.stringify({error: 'intake not configured'}));
      }
      const body = url.pathname === '/health'
        ? {status: 'ok'}
        : url.pathname === '/status'
          ? intake.status()
          : await archive.list();
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify(body, null, 2));
    } catch (error) {
      response.writeHead(500, {'content-type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify({error: error.message}));
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '0.0.0.0', resolve);});
  return {origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve))};
}
