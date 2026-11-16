// FIX 4.4 报文解析：只处理本地演练网关的回报，不发起任何下单。
// 传输属性（MsgSeqNum 34、PossDupFlag 43、OrigSendingTime 122）
// 与业务身份（TradeReportID 571、TradeReportRefID 572）分别取值、分别管理。
export const TAG = Object.freeze({
  BEGIN_STRING: '8',
  BODY_LENGTH: '9',
  MSG_TYPE: '35',
  SENDER_COMP_ID: '49',
  TARGET_COMP_ID: '52',
  MSG_SEQ_NUM: '34',
  POSS_DUP_FLAG: '43',
  ORIG_SENDING_TIME: '122',
  GAP_FILL_FLAG: '123',
  NEW_SEQ_NO: '36',
  TRADE_REPORT_ID: '571',
  TRADE_REPORT_REF_ID: '572',
  CHECK_SUM: '10',
});

export const MSG_TYPE = Object.freeze({
  TRADE_REPORT: 'AE',
  SEQUENCE_RESET: '4',
});

const SOH = '\u0001';

// 兼容旧采集器：返回 {fields, raw}，同时补充解析后的标签表与校验结果。
export function envelope(encoded) {
  const message = parseFix(encoded);
  return {fields: message.fields, tags: message.tags, raw: encoded};
}

export function parseFix(encoded) {
  const bytes = Buffer.from(encoded, 'base64');
  const text = bytes.toString('ascii');
  const parts = text.split(SOH).filter(Boolean);
  if (parts.length < 3 || !parts[0].startsWith('8=FIX.4.4') || !parts.at(-1).startsWith('10=')) {
    throw new Error('invalid FIX envelope');
  }
  const fields = [];
  const tags = Object.create(null);
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) throw new Error('invalid FIX field');
    const tag = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!/^\d+$/.test(tag)) throw new Error('invalid FIX field tag');
    fields.push([tag, value]);
    tags[tag] = value;
  }

  const firstSoh = text.indexOf(SOH);
  const bodyStart = text.indexOf(SOH, firstSoh + 1) + 1; // BodyLength 从 9= 字段之后开始
  const checkField = parts.at(-1);
  const checkMarker = `${SOH}${checkField}`;
  const checkIndex = text.indexOf(checkMarker);
  const givenLength = Number(tags[TAG.BODY_LENGTH]);
  // BodyLength 覆盖到 CheckSum 标签前的 SOH（含该分隔符）。
  const actualLength = checkIndex + 1 - bodyStart;
  if (!Number.isInteger(givenLength) || givenLength !== actualLength) {
    throw new Error('invalid FIX BodyLength');
  }

  const givenChecksum = checkField.slice(3);
  if (!/^\d{3}$/.test(givenChecksum)) throw new Error('invalid FIX CheckSum');
  const actualChecksum = bytes.subarray(0, checkIndex + 1).reduce((sum, byte) => sum + byte, 0) % 256;
  if (Number(givenChecksum) !== actualChecksum) throw new Error('invalid FIX CheckSum');

  if (!tags[TAG.MSG_TYPE]) throw new Error('invalid FIX MsgType');
  const seqNum = Number(tags[TAG.MSG_SEQ_NUM]);
  if (!Number.isInteger(seqNum) || seqNum <= 0) throw new Error('invalid FIX MsgSeqNum');

  const possDup = tags[TAG.POSS_DUP_FLAG] === 'Y';
  if (possDup && !tags[TAG.ORIG_SENDING_TIME]) {
    throw new Error('invalid FIX PossDup without OrigSendingTime');
  }

  return {
    raw: encoded,
    fields,
    tags,
    msgType: tags[TAG.MSG_TYPE],
    seqNum,
    possDup,
    origSendingTime: tags[TAG.ORIG_SENDING_TIME] ?? null,
  };
}
