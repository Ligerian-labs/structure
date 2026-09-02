import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type CronFields,
  describeCron,
  InvalidCronExpression,
  nextRun,
  parseCron,
} from "../src/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const parse = (expression: string): Promise<CronFields> => run(parseCron(expression));

describe("cron parsing", () => {
  test("accepts standard forms and normalizes sunday", async () => {
    expect((await parse("* * * * *")).minutes).toHaveLength(60);
    expect((await parse("*/15 0-6 * * 1-5")).minutes).toEqual([0, 15, 30, 45]);
    expect((await parse("0 9 * * 7")).daysOfWeek).toEqual([0]);
    expect((await parse("30 2 1 1,7 *")).months).toEqual([1, 7]);
    expect((await parse("5-10/3 * * * *")).minutes).toEqual([5, 8]);
  });

  test("rejects malformed expressions with every problem listed", async () => {
    const error = await Effect.runPromise(Effect.flip(parseCron("61 25 * * x")));
    expect(error).toBeInstanceOf(InvalidCronExpression);
    if (error instanceof InvalidCronExpression) {
      expect(error.problems.length).toBeGreaterThanOrEqual(2);
    }
    const missingField = await Effect.runPromise(Effect.flip(parseCron("* * * *")));
    expect(missingField).toBeInstanceOf(InvalidCronExpression);
  });

  test("describeCron renders a human summary", async () => {
    expect(describeCron(await parse("30 9 * * mon-fri"))).toContain("09:30");
    expect(describeCron(await parse("30 9 * * mon-fri"))).toContain("mon");
  });
});

describe("cron nextRun", () => {
  test("every-minute fires the minute after `after`", async () => {
    const fields = await parse("* * * * *");
    const after = new Date("2026-08-20T12:04:30.000Z");
    expect(nextRun(after, fields)?.toISOString()).toBe("2026-08-20T12:05:00.000Z");
  });

  test("step minutes skip to the next step", async () => {
    const fields = await parse("*/15 * * * *");
    const after = new Date("2026-08-20T12:16:00.000Z");
    expect(nextRun(after, fields)?.toISOString()).toBe("2026-08-20T12:30:00.000Z");
  });

  test("weekdays at 09:30 skips the weekend", async () => {
    const fields = await parse("30 9 * * mon-fri");
    const friday = new Date("2026-08-21T10:00:00.000Z"); // Friday
    expect(nextRun(friday, fields)?.toISOString()).toBe("2026-08-24T09:30:00.000Z"); // Monday
  });

  test("day-of-month and month fields bind", async () => {
    const fields = await parse("0 0 1 3 *");
    const after = new Date("2026-08-21T00:00:00.000Z");
    expect(nextRun(after, fields)?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  test("posix dom-or-dow semantics when both are restricted", async () => {
    const fields = await parse("0 0 13 * fri"); // the 13th, or any Friday
    const after = new Date("2026-08-14T01:00:00.000Z"); // Friday Aug 14 already passed midnight
    const next = nextRun(after, fields);
    expect(next).toBeDefined();
    // Next fire: Friday Aug 21 (dow matches before the 13th of September).
    expect(next?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  test("timezones evaluate wall-clock time with DST handling", async () => {
    const fields = await parse("0 9 * * *");
    // Winter: America/New_York is UTC-5.
    const winterAfter = new Date("2026-01-15T00:00:00.000Z");
    expect(nextRun(winterAfter, fields, "America/New_York")?.toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    // Summer: UTC-4.
    const summerAfter = new Date("2026-07-15T00:00:00.000Z");
    expect(nextRun(summerAfter, fields, "America/New_York")?.toISOString()).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });
});
