import {TAG} from '../src/fix.mjs';

const SOH = '\u0001';

// 测试用 FIX 4.4 编码器：自动计算 BodyLength(9) 与 CheckSum(10)。
export function encodeFix(fields) {
  const ordered = fields.filter(([tag]) => tag !== TAG.BODY_LENGTH && tag !== TAG.CHECK_SUM);
  const body = ordered.map(([tag, value]) => `${tag}=${value}`).join(SOH) + SOH;
  const head = `8=FIX.4.4${SOH}9=${body.length}${SOH}`;
  const headAndBody = head + body;
  const checksum = Buffer.from(headAndBody, 'ascii').reduce((sum, byte) => sum + byte, 0) % 256;
  const text = `${headAndBody}10=${String(checksum).padStart(3, '0')}${SOH}`;
  return Buffer.from(text, 'ascii').toString('base64');
}

export function tradeReport({seqNum, reportId, refId, possDup, origSendingTime, lastPx = '10', lastQty = '5'}) {
  const fields = [
    [TAG.BEGIN_STRING, 'FIX.4.4'],
    [TAG.MSG_TYPE, 'AE'],
    [TAG.MSG_SEQ_NUM, String(seqNum)],
    ['49', 'PARTNER'],
    ['56', 'LOCAL'],
  ];
  if (possDup) {
    fields.push([TAG.POSS_DUP_FLAG, 'Y']);
    fields.push([TAG.ORIG_SENDING_TIME, origSendingTime ?? '20261101-00:00:00']);
  }
  fields.push([TAG.TRADE_REPORT_ID, reportId]);
  if (refId) fields.push([TAG.TRADE_REPORT_REF_ID, refId]);
  fields.push(['31', lastPx], ['32', lastQty]);
  return encodeFix(fields);
}

export function gapFill(seqNum, newSeqNo) {
  return encodeFix([
    [TAG.BEGIN_STRING, 'FIX.4.4'],
    [TAG.MSG_TYPE, '4'],
    [TAG.MSG_SEQ_NUM, String(seqNum)],
    ['49', 'PARTNER'],
    ['56', 'LOCAL'],
    [TAG.GAP_FILL_FLAG, 'Y'],
    [TAG.NEW_SEQ_NO, String(newSeqNo)],
  ]);
}
