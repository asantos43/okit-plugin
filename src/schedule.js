// Schedule engine: parse a schedule and decide when it is due.
// Pure functions, an injected clock and no I/O, so it runs anywhere.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The search stays bounded so a schedule that can never match cannot spin.
const MAX_DAYS = 5 * 366;
const GAP_WINDOW_MS = 36 * HOUR_MS;

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const WEEKDAY_LABELS = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH_LABELS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const ACCEPTED_FORMS = [
  'Accepted forms: 5-field cron (minute hour day-of-month month day-of-week)',
  'with *, lists (1,2), ranges (1-5), steps (*/15, 1-30/5) and names (mon-fri, jan);',
  '"daily HH:MM"; "weekly <sun..sat> HH:MM"; "monthly day <1-31> HH:MM";',
  '"after each <event>".',
].join(' ');

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall clock parts of an instant in a zone. */
function zonedParts(ms, timeZone) {
  const seen = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) seen[part.type] = part.value;
  return {
    year: Number(seen.year),
    month: Number(seen.month),
    day: Number(seen.day),
    hour: Number(seen.hour),
    minute: Number(seen.minute),
    second: Number(seen.second),
    weekday: WEEKDAY_NAMES.indexOf(seen.weekday.slice(0, 3).toLowerCase()),
  };
}

function wallEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Zone offset from UTC, in ms, at an instant. */
function offsetAt(ms, timeZone) {
  const second = Math.floor(ms / 1000) * 1000;
  return wallEpoch(zonedParts(second, timeZone)) - second;
}

/**
 * Instants whose wall clock in a zone is exactly `wallMs`. There is one in a
 * normal period, two inside a repeated hour and none inside a skipped hour.
 */
function wallCandidates(wallMs, timeZone) {
  const found = new Set();
  const offsets = [
    offsetAt(wallMs, timeZone),
    offsetAt(wallMs - DAY_MS, timeZone),
    offsetAt(wallMs + DAY_MS, timeZone),
  ];
  for (const offset of offsets) {
    const instant = wallMs - offset;
    if (offsetAt(instant, timeZone) === offset) found.add(instant);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Earliest instant at or after a wall time that exists. Used only for a wall
 * time inside a skipped hour, where the answer is the end of the gap.
 */
function firstInstantFromWall(wallMs, timeZone) {
  const reached = (instant) => wallEpoch(zonedParts(instant, timeZone)) >= wallMs;
  let low = Math.floor((wallMs - GAP_WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  let high = Math.ceil((wallMs + GAP_WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.ceil((high - low) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (reached(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * Instant of a wall clock time in a zone. A repeated hour runs on its first
 * pass, so it happens once; a skipped hour moves to the next valid minute, so
 * it is neither lost nor run twice.
 */
function instantFromWall(wallMs, timeZone) {
  const candidates = wallCandidates(wallMs, timeZone);
  return candidates.length > 0 ? candidates[0] : firstInstantFromWall(wallMs, timeZone);
}

const sorted = (values) => [...new Set(values)].sort((a, b) => a - b);

function invalid(text) {
  return new TypeError(`Cannot parse schedule ${JSON.stringify(String(text))}. ${ACCEPTED_FORMS}`);
}

function tokenValue(token, bounds, text) {
  const lower = token.trim().toLowerCase();
  const labels = bounds.labels ?? {};
  let value;
  if (Object.hasOwn(labels, lower)) value = labels[lower];
  else if (/^\d+$/.test(lower)) value = Number(lower);
  else throw invalid(text);
  if (value < bounds.min || value > bounds.max) throw invalid(text);
  return value;
}

/** Expands one cron field into its values: *, lists, ranges, steps and names. */
function parseCronField(raw, bounds, text) {
  const values = [];
  for (const piece of raw.split(',')) {
    const parts = piece.split('/');
    if (parts.length > 2 || piece === '') throw invalid(text);
    const [range, stepText] = parts;
    if (stepText !== undefined && !/^[1-9]\d*$/.test(stepText)) throw invalid(text);
    const step = stepText === undefined ? 1 : Number(stepText);
    let from;
    let to;
    if (range === '*') {
      from = bounds.min;
      to = bounds.max;
    } else {
      const edges = range.split('-');
      if (edges.length > 2) throw invalid(text);
      from = tokenValue(edges[0], bounds, text);
      to = edges.length === 2 ? tokenValue(edges[1], bounds, text) : from;
    }
    if (from > to) throw invalid(text);
    for (let value = from; value <= to; value += step) values.push(value);
  }
  return values;
}

const FIELDS = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12, labels: MONTH_LABELS },
  dayOfWeek: { min: 0, max: 7, labels: WEEKDAY_LABELS },
};

// Sunday is both 0 and 7 on the way in; inside a schedule it is always 0.
const normalizeWeekday = (value) => (value === 7 ? 0 : value);

function parseClock(raw, text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) throw invalid(text);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseCron(parts, text) {
  if (parts.length !== 5) throw invalid(text);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = [
    FIELDS.minute,
    FIELDS.hour,
    FIELDS.dayOfMonth,
    FIELDS.month,
    FIELDS.dayOfWeek,
  ].map((bounds, index) => sorted(parseCronField(parts[index], bounds, text).map((value) => (
    bounds === FIELDS.dayOfWeek ? normalizeWeekday(value) : value
  ))));
  return {
    kind: 'cron',
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    // Like cron: two restricted day fields match on either one; a free field
    // means every day matches, so only the other field decides.
    dayOfMonthRestricted: parts[2] !== '*',
    dayOfWeekRestricted: parts[4] !== '*',
  };
}

function parseFriendly(kind, parts, text) {
  if (kind === 'daily') {
    if (parts.length !== 2) throw invalid(text);
    return { kind: 'daily', ...parseClock(parts[1], text) };
  }
  if (kind === 'weekly') {
    if (parts.length !== 3) throw invalid(text);
    const days = sorted(parseCronField(parts[1], FIELDS.dayOfWeek, text).map(normalizeWeekday));
    return { kind: 'weekly', days, ...parseClock(parts[2], text) };
  }
  if (parts.length !== 4 || parts[1].toLowerCase() !== 'day') throw invalid(text);
  const day = tokenValue(parts[2], FIELDS.dayOfMonth, text);
  return { kind: 'monthly', day, ...parseClock(parts[3], text) };
}

/**
 * Parses a schedule into its normalized form.
 *
 * Throws a `TypeError` naming every accepted form when the text is not one.
 */
export function parseSchedule(text) {
  if (typeof text !== 'string' || text.trim() === '') throw invalid(text);
  const parts = text.trim().split(/\s+/);
  const head = parts[0].toLowerCase();
  if (head === 'after') {
    if (parts.length !== 3 || parts[1].toLowerCase() !== 'each') throw invalid(text);
    const event = parts[2].toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(event)) throw invalid(text);
    return { kind: 'event', event };
  }
  if (head === 'daily' || head === 'weekly' || head === 'monthly') {
    return parseFriendly(head, parts, text);
  }
  return parseCron(parts, text);
}

/** Tells whether an event schedule fires on a named event. */
export function eventFires(schedule, eventName) {
  return Boolean(schedule)
    && schedule.kind === 'event'
    && typeof eventName === 'string'
    && eventName.trim().toLowerCase() === schedule.event;
}

/** Cursor of the local day an instant falls in. */
function dayStart(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Calendar day of a cursor, which only ever walks whole UTC days. */
function calendarDay(cursor) {
  const date = new Date(cursor);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function dayMatches(schedule, cursor) {
  const { year, month, day, weekday } = calendarDay(cursor);
  if (schedule.kind === 'cron') {
    if (!schedule.month.includes(month)) return false;
    const byDayOfMonth = schedule.dayOfMonth.includes(day);
    const byDayOfWeek = schedule.dayOfWeek.includes(weekday);
    if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
      return byDayOfMonth || byDayOfWeek;
    }
    return byDayOfMonth && byDayOfWeek;
  }
  if (schedule.kind === 'daily') return true;
  if (schedule.kind === 'weekly') return schedule.days.includes(weekday);
  // A shorter month runs on its last day instead of skipping the month.
  return day === Math.min(schedule.day, daysInMonth(year, month));
}

function timesOfDay(schedule) {
  if (schedule.kind !== 'cron') return [{ hour: schedule.hour, minute: schedule.minute }];
  const times = [];
  for (const hour of schedule.hour) {
    for (const minute of schedule.minute) times.push({ hour, minute });
  }
  return times;
}

function instantsOnDay(cursor, times, timeZone) {
  const { year, month, day } = calendarDay(cursor);
  const base = Date.UTC(year, month - 1, day);
  return times
    .map((time) => instantFromWall(base + time.hour * HOUR_MS + time.minute * MINUTE_MS, timeZone))
    .sort((a, b) => a - b);
}

const KINDS = new Set(['cron', 'daily', 'weekly', 'monthly', 'event']);

// A schedule always comes from parseSchedule, so a missing field means the
// caller built one by hand and deserves a plain error instead of a NaN.
function requireSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || !KINDS.has(schedule.kind)) {
    throw new TypeError('A schedule must be built by parseSchedule.');
  }
  return schedule;
}

/**
 * First instant strictly after `afterMs` that matches, read on the wall clock
 * of `timeZone`. Event schedules are never due by time, so they return `null`,
 * and so does a schedule with no slot within the search bound.
 */
export function nextRun(schedule, afterMs, { timeZone = 'UTC' } = {}) {
  if (requireSchedule(schedule).kind === 'event') return null;
  const times = timesOfDay(schedule);
  for (let step = 0, cursor = dayStart(afterMs, timeZone); step < MAX_DAYS; step += 1, cursor += DAY_MS) {
    if (!dayMatches(schedule, cursor)) continue;
    for (const instant of instantsOnDay(cursor, times, timeZone)) {
      if (instant > afterMs) return instant;
    }
  }
  return null;
}

/** Last slot at or before `atMs`, which is the period a run belongs to. */
function latestRun(schedule, atMs, { timeZone = 'UTC' } = {}) {
  if (requireSchedule(schedule).kind === 'event') return null;
  const times = timesOfDay(schedule);
  for (let step = 0, cursor = dayStart(atMs, timeZone); step < MAX_DAYS; step += 1, cursor -= DAY_MS) {
    if (!dayMatches(schedule, cursor)) continue;
    const instants = instantsOnDay(cursor, times, timeZone);
    for (let index = instants.length - 1; index >= 0; index -= 1) {
      if (instants[index] <= atMs) return instants[index];
    }
  }
  return null;
}

const minutesOfDay = (parts) => parts.hour * 60 + parts.minute;

function windowMinutes(raw) {
  const match = typeof raw === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Tells whether an instant is inside a `{from, to}` window of `HH:MM` times,
 * which may cross midnight. No window means always.
 */
export function isInWindow(win, nowMs, { timeZone = 'UTC' } = {}) {
  if (win === undefined || win === null) return true;
  const from = windowMinutes(win.from);
  const to = windowMinutes(win.to);
  if (from === null || to === null) {
    throw new TypeError('A window needs from and to as HH:MM.');
  }
  const now = minutesOfDay(zonedParts(nowMs, timeZone));
  if (from === to) return true;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;
}

const result = (due, action, reason, period = null) => ({ due, action, reason, period });

const periodKey = (instant) => new Date(instant).toISOString();

/**
 * Decides whether a template should run now.
 *
 * `template` holds the schedule and its guards; `ctx` holds what only the
 * caller knows (quota, idleness, an open child, runs in the current period).
 * `period` is the ISO instant of the slot being run, so a child demand can be
 * opened once per period even if the check runs twice.
 */
export function evaluateDue(template, nowMs, ctx = {}) {
  const {
    window,
    timeZone = 'UTC',
    minQuotaPct,
    onlyWhenIdle = false,
    skipIfOpen = true,
    catchup = 'run',
    lastRun,
    paused,
    maxRunsPerPeriod,
  } = template;
  const schedule = requireSchedule(typeof template.schedule === 'string'
    ? parseSchedule(template.schedule)
    : template.schedule);
  const { quotaPct, idle, openChild, runsThisPeriod, eventName, eventId } = ctx;

  if (paused) return result(false, 'skip', 'the schedule is paused');

  let slot = null;
  if (schedule.kind === 'event') {
    if (!eventFires(schedule, eventName)) {
      return result(false, 'defer', 'the schedule waits for its event');
    }
    // An event has no slot instant, so its own name keys the period.
    slot = eventId === undefined ? `event:${schedule.event}` : `event:${schedule.event}:${eventId}`;
  } else {
    const current = latestRun(schedule, nowMs, { timeZone });
    if (current === null) return result(false, 'defer', 'the schedule has no slot yet');
    if (lastRun === undefined || lastRun === null) {
      // Without history there is nothing to catch up, so the template waits for
      // the slot of the current day instead of firing for one already gone.
      if (dayStart(current, timeZone) !== dayStart(nowMs, timeZone)) {
        return result(false, 'defer', 'the first slot of this period has not arrived yet');
      }
      slot = current;
    } else if (current <= lastRun) {
      return result(false, 'defer', 'the slot for this period already ran');
    } else {
      const oldest = nextRun(schedule, lastRun, { timeZone });
      const following = nextRun(schedule, oldest, { timeZone });
      const alsoMissed = following !== null && following <= nowMs;
      slot = catchup === 'skip' && alsoMissed ? current : oldest;
    }
  }

  const period = typeof slot === 'number' ? periodKey(slot) : slot;

  if (!isInWindow(window, nowMs, { timeZone })) {
    return result(false, 'defer', 'the slot is due but now is outside the window', period);
  }
  if (typeof quotaPct === 'number' && typeof minQuotaPct === 'number' && quotaPct < minQuotaPct) {
    return result(false, 'defer', 'the quota is below the minimum for this template', period);
  }
  if (onlyWhenIdle && idle === false) {
    return result(false, 'defer', 'the client is busy and the template only runs when idle', period);
  }
  if (skipIfOpen && openChild) {
    return result(false, 'skip', 'a run of this template is already open', period);
  }
  if (typeof maxRunsPerPeriod === 'number' && typeof runsThisPeriod === 'number'
    && runsThisPeriod >= maxRunsPerPeriod) {
    return result(false, 'skip', 'this period already had the maximum number of runs', period);
  }
  return result(true, 'run', 'the slot is due and every guard allows it', period);
}