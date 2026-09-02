import { Data, Effect } from "effect";

/** A cron expression is invalid (unknown field, out of range, bad syntax). */
export class InvalidCronExpression extends Data.TaggedError("InvalidCronExpression")<{
  readonly expression: string;
  readonly problems: ReadonlyArray<string>;
}> {
  readonly classification: "permanent" = "permanent";
  override get message(): string {
    return `invalid cron expression "${this.expression}": ${this.problems.join("; ")}`;
  }
}

/** A 5-field cron schedule: minute hour day-of-month month day-of-week. */
export interface CronFields {
  readonly minutes: ReadonlyArray<number>;
  readonly hours: ReadonlyArray<number>;
  readonly daysOfMonth: ReadonlyArray<number>;
  readonly months: ReadonlyArray<number>;
  readonly daysOfWeek: ReadonlyArray<number>;
  /** `true` when day-of-month is unrestricted (`*`) — matters when dow is restricted. */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const RANGES: ReadonlyArray<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 6],
];

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const parseField = (
  field: string,
  name: string,
  min: number,
  max: number,
): Effect.Effect<ReadonlyArray<number>, string> =>
  Effect.gen(function* () {
    const values = new Set<number>();
    for (const part of field.split(",")) {
      const stepMatch = /^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/u.exec(part.trim());
      if (stepMatch === null) {
        return yield* Effect.fail(`${name}: cannot parse "${part}"`);
      }
      const rangePart = stepMatch[1] ?? "";
      const step = stepMatch[2] === undefined ? 1 : Number(stepMatch[2]);
      if (!Number.isInteger(step) || step < 1) {
        return yield* Effect.fail(`${name}: step must be a positive integer`);
      }
      let from = min;
      let to = max;
      if (rangePart !== "*") {
        if (rangePart.includes("-")) {
          const [rawFrom, rawTo] = rangePart.split("-");
          from = Number(rawFrom);
          to = Number(rawTo);
        } else {
          from = Number(rangePart);
          to = rangePart.includes("/") ? max : from;
        }
      }
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
        return yield* Effect.fail(`${name}: values must be within ${min}-${max}`);
      }
      for (let value = from; value <= to; value += step) values.add(value);
    }
    return [...values].sort((a, b) => a - b);
  });

/**
 * Parses a standard 5-field cron expression: `*`, lists (`1,15`), ranges
 * (`1-5`), steps (every-10th `0/10`, range-stepped `5-40/5`). Day-of-week:
 * 0 and 7 are Sunday.
 */
export const parseCron = (expression: string): Effect.Effect<CronFields, InvalidCronExpression> =>
  Effect.gen(function* () {
    const parts = expression.trim().split(/\s+/u);
    if (parts.length !== 5) {
      return yield* new InvalidCronExpression({
        expression,
        problems: [
          `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
        ],
      });
    }
    const problems: Array<string> = [];
    const parsed: Array<ReadonlyArray<number>> = [];
    for (let index = 0; index < parts.length; index++) {
      const [name, min, max] = RANGES[index] ?? ["field", 0, 0];
      const part = parts[index] ?? "*";
      const field = part
        .replace(/^7$/u, "0")
        .replace(/\b(sun|mon|tue|wed|thu|fri|sat)\b/giu, (name) =>
          String(DAY_NAMES[name.toLowerCase()] ?? name),
        );
      const result = yield* parseField(field, name, min, max).pipe(Effect.either);
      if (result._tag === "Left") {
        problems.push(result.left);
        parsed.push([]);
      } else {
        parsed.push(result.right);
      }
    }
    if (problems.length > 0) {
      return yield* new InvalidCronExpression({ expression, problems });
    }
    const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
      ReadonlyArray<number>,
      ReadonlyArray<number>,
      ReadonlyArray<number>,
      ReadonlyArray<number>,
      ReadonlyArray<number>,
    ];
    return {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      domRestricted: daysOfMonth.length !== 31,
      dowRestricted: daysOfWeek.length !== 7,
    };
  });

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Human-readable summary, e.g. `at 09:30 every mon-fri`. */
export const describeCron = (fields: CronFields): string => {
  const time =
    fields.hours.length === 24 && fields.minutes.length === 60
      ? "every minute"
      : fields.hours
          .flatMap((hour) =>
            fields.minutes.map(
              (minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
            ),
          )
          .join(", ");
  const days = fields.dowRestricted
    ? fields.daysOfWeek.map((day) => DAYS[day] ?? String(day)).join(", ")
    : "every day";
  const months = fields.months.length === 12 ? "" : ` in months ${fields.months.join(",")}`;
  const dom = fields.domRestricted ? ` on days ${fields.daysOfMonth.join(",")}` : "";
  return `at ${time} ${days}${dom}${months}`;
};

interface WallClock {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number; // 0=Sunday
}

const wallClockFormatter = (timeZone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  }
};

const weekdayIndex: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const wallClockOf = (instant: Date, formatter: Intl.DateTimeFormat): WallClock => {
  const parts = formatter.formatToParts(instant);
  const pick = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "0";
    return Number(value);
  };
  const weekday = weekdayIndex[parts.find((part) => part.type === "weekday")?.value ?? "Sun"] ?? 0;
  const hour = pick("hour") % 24;
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
    weekday,
  };
};

/** UTC instant for a wall-clock time in `timeZone` (two-pass DST offset). */
const instantFromWallClock = (
  clock: Omit<WallClock, "weekday">,
  formatter: Intl.DateTimeFormat,
): Date => {
  const guess = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, 0, 0);
  const wallAtGuess = wallClockOf(new Date(guess), formatter);
  const wallAsUtc = Date.UTC(
    wallAtGuess.year,
    wallAtGuess.month - 1,
    wallAtGuess.day,
    wallAtGuess.hour,
    wallAtGuess.minute,
    0,
    0,
  );
  const offset = wallAsUtc - guess;
  return new Date(guess - offset);
};

const dayMatches = (clock: WallClock, fields: CronFields): boolean => {
  if (!fields.months.includes(clock.month)) return false;
  const domOk = fields.daysOfMonth.includes(clock.day);
  const dowOk = fields.daysOfWeek.includes(clock.weekday);
  // POSIX cron: when both dom and dow are restricted, either may match.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
};

const SEARCH_LIMIT_DAYS = 400;

/**
 * The next fire time strictly after `after`, in the expression's timezone
 * (default UTC). Missed occurrences are skipped — the scheduler never
 * bursts to catch up on time that already passed while it was down.
 */
export const nextRun = (after: Date, fields: CronFields, timeZone = "UTC"): Date | undefined => {
  const formatter = wallClockFormatter(timeZone);
  const start = wallClockOf(after, formatter);
  for (let dayOffset = 0; dayOffset <= SEARCH_LIMIT_DAYS; dayOffset++) {
    // Walk whole days: from the minute after `after` on day 0, then full days.
    const base = instantFromWallClock(
      {
        year: start.year,
        month: start.month,
        day: start.day,
        hour: 0,
        minute: 0,
      },
      formatter,
    );
    const dayStart = new Date(base.getTime() + dayOffset * 86_400_000);
    const dayClock = wallClockOf(dayStart, formatter);
    if (!dayMatches(dayClock, fields)) continue;
    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        const candidate = instantFromWallClock(
          {
            year: dayClock.year,
            month: dayClock.month,
            day: dayClock.day,
            hour,
            minute,
          },
          formatter,
        );
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }
  return undefined;
};
