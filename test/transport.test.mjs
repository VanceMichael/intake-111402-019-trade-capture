import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,SourceError} from '../src/transport.mjs';
import {createSource} from '../src/source.mjs';
test('来源地址和非成功响应保留边界',async () => {
  assert.throws(() => createClient('https://example.com'),/local source/);
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    await assert.rejects(client('http://example.com/data'),/foreign source/);
    await assert.rejects(client('/unknown'),error => error instanceof SourceError && error.status === 404);
    await assert.rejects(client('/__scenario',{method:'POST',body:{name:'missing'}}),/400/);
  } finally {await source.close();}
});
