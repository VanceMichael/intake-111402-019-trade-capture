import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseFix, envelope, TAG, MSG_TYPE} from '../src/fix.mjs';
import {encodeFix} from '../test-support/fix-builder.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const allItems = [
  ...fixture.exchanges.find(route => route.path === '/messages').body.items,
  ...Object.values(fixture.cases).flatMap(route => route.find(r => r.path === '/messages').body.items),
];

test('解析保留原始字段并区分传输属性与业务身份', () => {
  const message = parseFix(allItems[0]);
  assert.equal(message.msgType, MSG_TYPE.TRADE_REPORT);
  assert.equal(message.seqNum, 1);
  assert.equal(message.tags[TAG.TRADE_REPORT_ID], 'T1');
  assert.equal(message.possDup, false);
  assert.equal(message.fields[0][1], 'FIX.4.4');
  const legacy = envelope(allItems[0]);
  assert.deepEqual(legacy.fields, message.fields);
  assert.equal(legacy.raw, allItems[0]);
});

test('PossDupFlag 重送带 OrigSendingTime，GapFill 被识别为管理消息', () => {
  const resentItem = allItems.find(item => Buffer.from(item, 'base64').toString('ascii').includes('43=Y\u0001'));
  const gapFillItem = allItems.find(item => Buffer.from(item, 'base64').toString('ascii').includes('35=4\u0001'));
  const resent = parseFix(resentItem);
  assert.equal(resent.possDup, true);
  assert.equal(resent.origSendingTime, '20261101-00:00:00');
  assert.equal(resent.tags[TAG.TRADE_REPORT_ID], 'T2');
  const gapFill = parseFix(gapFillItem);
  assert.equal(gapFill.msgType, MSG_TYPE.SEQUENCE_RESET);
  assert.equal(gapFill.tags[TAG.GAP_FILL_FLAG], 'Y');
  assert.equal(Number(gapFill.tags[TAG.NEW_SEQ_NO]), 4);
});

test('BodyLength 与 CheckSum 必须通过校验', () => {
  const bytes = Buffer.from(allItems[0], 'base64');
  const text = bytes.toString('ascii');
  const brokenLength = Buffer.from(text.replace('9=49', '9=48'), 'ascii').toString('base64');
  assert.throws(() => parseFix(brokenLength), /BodyLength/);
  const brokenChecksum = Buffer.from(text.replace('10=029', '10=030'), 'ascii').toString('base64');
  assert.throws(() => parseFix(brokenChecksum), /CheckSum/);
  assert.throws(() => parseFix('eA=='), /invalid FIX envelope/);
});

test('PossDup 缺少 OrigSendingTime 时拒绝', () => {
  const noOrigTime = encodeFix([
    [TAG.BEGIN_STRING, 'FIX.4.4'],
    [TAG.MSG_TYPE, 'AE'],
    [TAG.MSG_SEQ_NUM, '2'],
    ['49', 'PARTNER'],
    ['56', 'LOCAL'],
    [TAG.POSS_DUP_FLAG, 'Y'],
    [TAG.TRADE_REPORT_ID, 'T2'],
  ]);
  assert.throws(() => parseFix(noOrigTime), /OrigSendingTime/);
});
