import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源场景切换保留真实交互记录',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    for (const name of ["gap-and-resend", "reset"]) {
      assert.equal((await client('/__scenario',{method:'POST',body:{name}})).scenario,name);
      const audit = await client('/__audit');
      assert.equal(audit.scenario,name);
    }
    await client('/__scenario',{method:'POST',body:{name:'normal'}});
    assert.equal((await client('/__audit')).scenario,'normal');
  } finally {await source.close();}
});
