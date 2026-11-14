import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';
test('相同收件幂等，不同内容保留版本',async () => {
  const directory = await mkdtemp(join(tmpdir(),'archive-'));
  try {
    const archive = new Archive(directory);
    await Promise.all([archive.put([{id:'one',value:1}],{source:'local'}),archive.put([{id:'one',value:1}],{source:'local'})]);
    assert.equal((await archive.list()).length,1);
    await archive.put([{id:'one',value:2}],{source:'local'});
    assert.equal((await new Archive(directory).list()).length,2);
    await assert.rejects(archive.put([{value:3}],{}),/record id/);
    const api = await createApi(archive);
    try {const response = await fetch(`${api.origin}/records`);assert.equal((await response.json()).length,2);}
    finally {await api.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});
