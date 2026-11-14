import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('gap-and-resend');
await client('/logon',{method:'POST',body:{}});
const messages = (await client('/messages?session=s1')).items.map(value => Buffer.from(value,'base64').toString('ascii'));
assert.ok(messages[1].includes('34=4\u0001'));
assert.ok(messages[2].includes('43=Y\u0001'));
assert.ok(messages[3].includes('35=4\u0001'));
await client('/resend',{method:'POST',body:{begin:2,end:3}});
assert.equal((await client('/__audit')).requests.at(-1).path,'/resend');
} finally {await source.close();}
});
