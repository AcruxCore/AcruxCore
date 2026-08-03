import type { EmailMessage } from './email.types';
import type { EmailTransport } from './email.transport';

/**
 * Collects messages in memory instead of sending them. Used by every test and
 * by local development, so no test can spend money or email a real person.
 */
export class MemoryTransport implements EmailTransport {
  private messages: EmailMessage[] = [];
  private failure: Error | null = null;

  /**
   * Records the message, or throws the error armed by {@link failWith}.
   *
   * @param message - The rendered message.
   * @returns A synthetic provider id, `memory-<n>`.
   * @throws {Error} Whatever {@link failWith} armed, to exercise failure paths.
   */
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    if (this.failure) throw this.failure;
    this.messages.push(message);
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[email:memory] to=${message.to} subject=${message.subject}`);
    }
    return { providerMessageId: `memory-${this.messages.length}` };
  }

  /**
   * @returns Every message accepted since the last {@link reset}, in order.
   */
  sent(): EmailMessage[] {
    return [...this.messages];
  }

  /** Clears collected messages and any armed failure. */
  reset(): void {
    this.messages = [];
    this.failure = null;
  }

  /**
   * Arms (or disarms) an error thrown by every subsequent {@link send}.
   *
   * @param err - The error to throw, or null to deliver normally again.
   */
  failWith(err: Error | null): void {
    this.failure = err;
  }
}

let singleton: MemoryTransport | null = null;

/**
 * The process-wide `MemoryTransport`. Tests assert against this exact instance,
 * so it must be the same object `resolveTransport()` hands to the service.
 *
 * @returns The memoized instance.
 */
export function getMemoryTransport(): MemoryTransport {
  if (!singleton) singleton = new MemoryTransport();
  return singleton;
}
