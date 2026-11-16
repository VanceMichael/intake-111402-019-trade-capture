// 持续收件循环：登录 -> 轮询 -> 落盘 -> 发现缺号则先持久化补发意图再请求来源补发。
// 恢复位置只由 Intake 在本地落盘成功后推进；网络错误不会伪造收件状态。
export async function runIntake(client, intake, options = {}) {
  const interval = options.interval ?? 200;
  const idleRounds = options.idleRounds ?? 2;
  const signal = options.signal;
  const onLogon = options.onLogon ?? (() => {});
  const onBatch = options.onBatch ?? (() => {});
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

  const logon = await client('/logon', {method: 'POST', body: {sender: 'LOCAL', target: 'PARTNER'}});
  const epoch = logon.sessionEpoch;
  await intake.load();
  await onLogon(epoch);

  let idle = 0;
  while (!signal?.aborted) {
    let response;
    try {
      response = await client(`/messages?session=${encodeURIComponent(epoch)}`);
    } catch (error) {
      // 断线：本地状态已落盘，下一轮重连仍能说明已收与待补，不把错误当业务内容。
      idle = 0;
      await sleep(interval);
      continue;
    }

    const result = await intake.ingest(epoch, response.items ?? []);
    await onBatch(result);

    const snapshot = intake.status().sessions[epoch];
    const pending = snapshot.pendingGapRanges;
    if (pending.length > 0) {
      for (const [begin, end] of pending) {
        const plan = await intake.requestResend(epoch, begin, end);
        if (!plan.duplicated) {
          try {
            const accepted = await client('/resend', {method: 'POST', body: {begin, end}});
            await intake.noteResendOutcome(epoch, begin, end, accepted?.accepted === true);
          } catch {
            // 补发请求未送达：意图已持久化，重连后仍可观察到该缺口。
          }
        }
      }
    }

    if (result.accepted === 0 && result.invalid === 0) {
      // 没有新原件落盘即计入空闲；缺口仍由持久化状态说明，重连或下次运行继续协作。
      idle += 1;
      if (idle >= idleRounds) break;
    } else {
      idle = 0;
    }
    await sleep(interval);
  }
  return intake.status();
}
