import { Effect } from "effect";
import type { EmailDriver } from "../driver.js";
import type { EmailMessage } from "../message.js";

export interface CapturedEmail {
  readonly message: EmailMessage;
  readonly sentAt: Date;
}

/**
 * Test/dev driver: records every message in memory and never fails. Pair
 * with `Mailer.layer` to assert on exactly what an application sent — same
 * port, same validation, same metrics as production drivers.
 */
export const makeCaptureDriver = (): EmailDriver & {
  readonly sent: ReadonlyArray<CapturedEmail>;
  readonly clear: () => void;
} => {
  const captured: Array<CapturedEmail> = [];
  return {
    name: "capture",
    send: (message) =>
      Effect.sync(() => {
        captured.push({ message, sentAt: new Date() });
      }),
    get sent(): ReadonlyArray<CapturedEmail> {
      return captured;
    },
    clear: () => {
      captured.length = 0;
    },
  };
};
