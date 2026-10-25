// Sends one message per recipient in order so bursts do not trip rate limits
// and one refusal never stops the others. Throws when nobody was reached.
export async function sendToEach(
  label: string,
  recipients: string[],
  send: (recipient: string) => Promise<void>,
): Promise<void> {
  let failed = 0;
  for (const recipient of recipients) {
    if (!(await sendOne(label, recipient, send))) failed += 1;
  }
  if (failed === recipients.length) {
    throw new Error(`${label} reached no one (${failed} failed).`);
  }
}

async function sendOne(label: string, recipient: string, send: (recipient: string) => Promise<void>): Promise<boolean> {
  try {
    await send(recipient);
    return true;
  } catch (reason) {
    console.error(`${label} was not sent to ${recipient}: ${errorText(reason)}`);
    return false;
  }
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
