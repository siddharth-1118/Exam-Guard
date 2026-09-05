import type { DesktopBridge } from '../../src/shared/types';

declare global {
  interface Window {
    examguard?: DesktopBridge;
  }
}

export function bridge(): DesktopBridge {
  if (!window.examguard) {
    throw new Error('Secure bridge unavailable — app must run inside ExamGuard desktop');
  }
  return window.examguard;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Wraps bridge calls so IPC errors surface as friendly messages. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    if (/Invalid email or password/i.test(message)) {
      throw new BridgeError('Incorrect email or password.', status);
    }
    if (/not assigned|not.*student|forbidden/i.test(message)) {
      throw new BridgeError('Your account is not permitted to take this exam.', status);
    }
    throw new BridgeError(message, status);
  }
}
