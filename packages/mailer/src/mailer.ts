import { Metrics } from "@structure-ai/observability";
import { Context, Duration, Effect, Layer, Metric, ParseResult, Schedule, Schema } from "effect";
import type { EmailDriver } from "./driver.js";
import { type MailError, MailValidationError } from "./errors.js";
import {
  defaultFromAddress,
  type EmailAddressInput,
  EmailMessage,
  type EmailMessageInput,
} from "./message.js";
import type { EmailTemplate } from "./templates.js";

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  readonly attempts?: number;
  /** Exponential backoff base. Default 200ms. */
  readonly baseDelay?: Duration.DurationInput;
  /** Backoff ceiling. Default 10s. */
  readonly maxDelay?: Duration.DurationInput;
}

export interface MailerOptions {
  /** Retry policy for transient (`MailDeliveryFailed`) deliveries. */
  readonly retry?: RetryOptions;
  /** Default `From` for template sends that omit one. */
  readonly defaultFrom?: EmailAddressInput;
}

const defaultAttempts = 3;
const defaultBaseDelay: Duration.DurationInput = "200 millis";
const defaultMaxDelay: Duration.DurationInput = "10 seconds";

const retrySchedule = (options: RetryOptions | undefined): Schedule.Schedule<unknown, MailError> =>
  Schedule.exponential(options?.baseDelay ?? defaultBaseDelay).pipe(
    Schedule.jittered,
    Schedule.modifyDelay((delay) => Duration.min(delay, options?.maxDelay ?? defaultMaxDelay)),
    Schedule.intersect(Schedule.recurs((options?.attempts ?? defaultAttempts) - 1)),
    // Transient delivery failures only; permanent rejections stop the schedule.
    Schedule.whileInput((error: MailError): boolean => error._tag === "MailDeliveryFailed"),
  );

/** Delivery metrics under one driver label (a bounded, low-cardinality set). */
export interface MailerMetrics {
  /** Successful sends, one per message. */
  readonly sends: Metric.Metric.Counter<number>;
  /** Final failures — retries exhausted, or permanent rejection. */
  readonly failures: Metric.Metric.Counter<number>;
  /** Transient failures seen across attempts (each retry-eligible miss). */
  readonly transientFailures: Metric.Metric.Counter<number>;
  /** Total send latency, retries included. */
  readonly latency: ReturnType<typeof Metric.timerWithBoundaries>;
}

export const makeMetrics = (driverName: string): MailerMetrics => ({
  sends: Metric.counter(`mailer_${driverName}_sends_total`, { incremental: true }),
  failures: Metric.counter(`mailer_${driverName}_failures_total`, { incremental: true }),
  transientFailures: Metric.counter(`mailer_${driverName}_transient_failures_total`, {
    incremental: true,
  }),
  latency: Metrics.boundary(`mailer_${driverName}`).duration,
});

const decodeMessage = Schema.decodeUnknown(EmailMessage);

/**
 * Converts a schema parse failure into a `MailValidationError` without
 * embedding decoded input values (issue messages can echo the payload).
 */
const invalid = (error: ParseResult.ParseError): MailValidationError => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  const first = issues[0];
  const path =
    first === undefined || first.path.length === 0 ? "" : `.${first.path.map(String).join(".")}`;
  const code = first?._tag ?? "invalid";
  return new MailValidationError({ field: `message${path}`, reason: code });
};

export interface TemplateEnvelope<T> {
  readonly data: T;
  readonly to: ReadonlyArray<EmailAddressInput>;
  readonly cc?: ReadonlyArray<EmailAddressInput>;
  readonly bcc?: ReadonlyArray<EmailAddressInput>;
  readonly from?: EmailAddressInput;
  readonly replyTo?: EmailAddressInput;
  readonly headers?: EmailMessageInput["headers"];
}

export interface MailerService {
  /**
   * Validates and delivers one message. Retries transient driver failures
   * with bounded jittered backoff; permanent rejections fail without retry.
   * Logs and metrics carry the driver label, a per-send message id, the
   * template name and recipient counts — never the subject or body.
   */
  readonly send: (message: EmailMessageInput) => Effect.Effect<EmailMessage, MailError>;
  /** Renders a typed template and sends it with the given envelope. */
  readonly sendTemplate: <T>(
    template: EmailTemplate<T>,
    envelope: TemplateEnvelope<T>,
  ) => Effect.Effect<EmailMessage, MailError>;
}

export class Mailer extends Context.Tag("@structure-ai/mailer/Mailer")<Mailer, MailerService>() {
  static layer(driver: EmailDriver, options?: MailerOptions): Layer.Layer<Mailer> {
    return Layer.succeed(Mailer, makeMailer(driver, options));
  }
}

export const makeMailer = (driver: EmailDriver, options?: MailerOptions): MailerService => {
  const metrics = makeMetrics(driver.name);
  const schedule = retrySchedule(options?.retry);
  const fallbackFrom = options?.defaultFrom ?? defaultFromAddress;

  const deliver = (message: EmailMessage, messageId: string): Effect.Effect<void, MailError> =>
    driver.send(message).pipe(
      Effect.tapError((error) =>
        error._tag === "MailDeliveryFailed"
          ? Effect.zipRight(
              Metric.increment(metrics.transientFailures),
              Effect.logWarning("mailer send attempt failed transiently").pipe(
                Effect.annotateLogs({
                  mailerDriver: driver.name,
                  mailerMessageId: messageId,
                  mailerTemplate: message.template ?? "ad-hoc",
                  mailerReason: error.reason,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.retry(schedule),
    );

  const sendValidated = (message: EmailMessage): Effect.Effect<EmailMessage, MailError> =>
    Effect.gen(function* () {
      const messageId = crypto.randomUUID();
      yield* deliver(message, messageId).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* Metric.increment(metrics.failures);
            yield* Effect.logError("mailer send failed").pipe(
              Effect.annotateLogs({
                mailerDriver: driver.name,
                mailerMessageId: messageId,
                mailerTemplate: message.template ?? "ad-hoc",
                mailerClassification: error.classification,
                mailerReason:
                  error._tag === "MailDeliveryFailed" || error._tag === "MailRejected"
                    ? error.reason
                    : "invalid",
              }),
            );
          }),
        ),
      );
      yield* Metric.increment(metrics.sends);
      yield* Effect.logInfo("mailer send").pipe(
        Effect.annotateLogs({
          mailerDriver: driver.name,
          mailerMessageId: messageId,
          mailerTemplate: message.template ?? "ad-hoc",
          mailerRecipients:
            message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0),
          mailerAttachments: message.attachments?.length ?? 0,
        }),
      );
      return message;
    }).pipe(Metric.trackDuration(metrics.latency));

  const validate = (input: EmailMessageInput): Effect.Effect<EmailMessage, MailError> =>
    decodeMessage(input).pipe(
      Effect.mapError(invalid),
      Effect.tapError((error) =>
        Effect.logWarning("mailer send rejected by validation").pipe(
          Effect.annotateLogs({
            mailerDriver: driver.name,
            mailerField: error.field,
            mailerReason: error.reason,
          }),
          Effect.asVoid,
        ),
      ),
    );

  return {
    send: (input) => Effect.flatMap(validate(input), sendValidated),
    sendTemplate: (template, envelope) =>
      Effect.gen(function* () {
        const rendered = template.render(envelope.data);
        const message: EmailMessageInput = {
          from: envelope.from ?? fallbackFrom,
          to: [...envelope.to],
          ...(envelope.cc === undefined ? {} : { cc: [...envelope.cc] }),
          ...(envelope.bcc === undefined ? {} : { bcc: [...envelope.bcc] }),
          ...(envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo }),
          subject: rendered.subject,
          ...(rendered.html === undefined ? {} : { html: rendered.html }),
          ...(rendered.text === undefined ? {} : { text: rendered.text }),
          ...(rendered.attachments === undefined ? {} : { attachments: [...rendered.attachments] }),
          ...(envelope.headers === undefined ? {} : { headers: envelope.headers }),
          template: template.name,
        };
        return yield* Effect.flatMap(validate(message), sendValidated);
      }),
  };
};
