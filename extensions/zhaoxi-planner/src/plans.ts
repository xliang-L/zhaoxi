import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  planParameters,
  planIdPattern as identifier,
  planDatePattern as datePattern,
  planTimePattern as timePattern,
  planProgressStatuses as statuses,
  planScenarios as scenarios,
} from "./plan-schema.js";
import { resolveScope } from "./scope.js";

type Item = {
  id: string;
  title: string;
  date?: string;
  weekdays?: number[];
  time?: string;
  endTime?: string;
  location?: string;
  course?: string;
  dueAt?: string;
  weeks?: number[];
  semesterStart?: string;
  excludedDates?: string[];
  minutes?: number;
};
type ProgressStatus = "completed" | "partial" | "skipped" | "pending";
type Progress = { status: ProgressStatus; note?: string; updatedAt: number };
type Plan = {
  id: string;
  title: string;
  scenario: "campus" | "exam" | "fitness";
  timezone: string;
  startDate?: string;
  endDate?: string;
  items: Item[];
  jobIds: string[];
  progress: Record<string, Progress>;
  updatedAt: number;
};

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifier.test(value)) {
    throw new Error(`${name} must contain 1–80 letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function date(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be a real calendar date in YYYY-MM-DD form.`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function parseItem(value: unknown): Item {
  if (!isRecord(value)) {
    throw new Error("Each plan item must be an object.");
  }
  const item: Item = { id: id(value.id, "item.id"), title: text(value.title, "item.title", 500) };
  if (value.date !== undefined) {
    item.date = date(value.date, "item.date");
  }
  if (value.weekdays !== undefined) {
    if (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7) {
      throw new Error("item.weekdays needs 1–7 weekday numbers, Monday=1 through Sunday=7.");
    }
    item.weekdays = [...new Set(value.weekdays.map((day) => integer(day, "weekday", 1, 7)))];
  }
  if ((item.date !== undefined) === (item.weekdays !== undefined)) {
    throw new Error("Each item needs exactly one of date or recurring weekdays.");
  }
  for (const field of ["time", "endTime"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string" || !timePattern.test(value[field])) {
        throw new Error(`item.${field} must use 24-hour HH:mm form.`);
      }
      item[field] = value[field];
    }
  }
  if (item.endTime && (!item.time || item.endTime <= item.time)) {
    throw new Error(
      "item.endTime must follow item.time on the same day; split overnight sessions.",
    );
  }
  for (const field of ["location", "course"] as const) {
    if (value[field] !== undefined) {
      item[field] = text(value[field], `item.${field}`, field === "course" ? 200 : 500);
    }
  }
  if (value.dueAt !== undefined) {
    const deadline = text(value.dueAt, "item.dueAt", 64);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(deadline) ||
      !Number.isFinite(Date.parse(deadline))
    ) {
      throw new Error("item.dueAt needs an ISO date/time with an explicit UTC offset.");
    }
    date(deadline.slice(0, 10), "item.dueAt date");
    item.dueAt = deadline;
  }
  if (value.semesterStart !== undefined) {
    item.semesterStart = date(value.semesterStart, "item.semesterStart");
    if (new Date(`${item.semesterStart}T00:00:00Z`).getUTCDay() !== 1) {
      throw new Error("item.semesterStart must be the semester's first Monday.");
    }
  }
  if (value.weeks !== undefined) {
    if (
      !Array.isArray(value.weeks) ||
      value.weeks.length < 1 ||
      value.weeks.length > 54 ||
      !item.semesterStart ||
      !item.weekdays
    ) {
      throw new Error("item.weeks needs 1–54 week numbers, recurring weekdays, and semesterStart.");
    }
    item.weeks = [...new Set(value.weeks.map((week) => integer(week, "course week", 1, 54)))];
  }
  if (value.excludedDates !== undefined) {
    if (!Array.isArray(value.excludedDates) || value.excludedDates.length > 366) {
      throw new Error("item.excludedDates must contain at most 366 dates.");
    }
    item.excludedDates = [...new Set(value.excludedDates.map((day) => date(day, "excluded date")))];
  }
  if (value.minutes !== undefined) {
    item.minutes = integer(value.minutes, "item.minutes", 1, 1440);
  }
  return item;
}

function parsePlan(
  value: unknown,
): Omit<Plan, "progress" | "updatedAt" | "jobIds"> & { jobIds?: string[] } {
  if (!isRecord(value)) {
    throw new Error(
      "save needs a complete plan object with id, title, scenario, timezone, and items.",
    );
  }
  const scenario = scenarios.find((candidate) => candidate === value.scenario);
  if (!scenario) {
    throw new Error("plan.scenario must be campus, exam, or fitness.");
  }
  const timezone = text(value.timezone, "plan.timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("plan.timezone must be a supported IANA timezone, such as Asia/Shanghai.");
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 200) {
    throw new Error("plan.items must contain 1–200 confirmed items.");
  }
  const items = value.items.map(parseItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("Plan item IDs must be unique.");
  }
  const plan: Omit<Plan, "progress" | "updatedAt" | "jobIds"> & { jobIds?: string[] } = {
    id: id(value.id, "plan.id"),
    title: text(value.title, "plan.title", 500),
    scenario,
    timezone,
    items,
  };
  if (value.startDate !== undefined) {
    plan.startDate = date(value.startDate, "plan.startDate");
  }
  if (value.endDate !== undefined) {
    plan.endDate = date(value.endDate, "plan.endDate");
  }
  if (plan.startDate && plan.endDate && plan.startDate > plan.endDate) {
    throw new Error("plan.endDate must be on or after plan.startDate.");
  }
  if (
    items.some(
      (item) =>
        item.date &&
        ((plan.startDate && item.date < plan.startDate) ||
          (plan.endDate && item.date > plan.endDate)),
    )
  ) {
    throw new Error("Dated items must fall within the plan's startDate/endDate.");
  }
  if (value.jobIds !== undefined) {
    if (!Array.isArray(value.jobIds) || value.jobIds.length > 100) {
      throw new Error("plan.jobIds must contain at most 100 successfully saved native job IDs.");
    }
    plan.jobIds = [...new Set(value.jobIds.map((job) => text(job, "native job ID", 200)))];
  }
  return plan;
}

function occursOn(plan: Plan, item: Item, day: string): boolean {
  if (
    (plan.startDate && day < plan.startDate) ||
    (plan.endDate && day > plan.endDate) ||
    item.excludedDates?.includes(day)
  ) {
    return false;
  }
  if (item.date) {
    return item.date === day;
  }
  const stamp = Date.parse(`${day}T00:00:00Z`);
  if (!item.weekdays?.includes(new Date(stamp).getUTCDay() || 7)) {
    return false;
  }
  if (item.semesterStart) {
    const week =
      Math.floor((stamp - Date.parse(`${item.semesterStart}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
    return week >= 1 && (!item.weeks || item.weeks.includes(week));
  }
  return true;
}

export function createPlanTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool {
  return {
    name: "zhaoxi_plan",
    label: "朝夕计划",
    description:
      "Save, list, or read the user's confirmed campus, exam, or fitness plan and record dated item progress. Use only when the user requests the relevant help; never proactively offer or enable these scenarios. No schedules are created by this tool. Use native automations only on an explicit reminder request, link returned jobIds, and put planId in the payload. get with date returns that local day's items and pendingItems excluding completed/skipped occurrences. save needs a complete replacement definition and preserves previous progress. Never save example/hypothetical plans or mark completion without user feedback. weekdays: Monday=1..Sunday=7.",
    parameters: planParameters,
    async execute(_toolCallId, input, signal) {
      const scope = resolveScope(context);
      scope.assertCurrent();
      signal?.throwIfAborted();
      if (!isRecord(input)) {
        throw new Error("Provide action save, get, list, or progress.");
      }
      const store = api.runtime.state.openKeyedStoreV2<Plan>(
        { namespace: "plans", retention: "retained" },
        { assertCurrent: scope.assertCurrent },
      );
      if (input.action === "list") {
        const limit = input.limit === undefined ? 20 : integer(input.limit, "limit", 1, 100);
        const cursor = input.cursor === undefined ? undefined : id(input.cursor, "cursor");
        const rows = await store.entriesInKeyRange({
          keyStartInclusive: scope.prefix + (cursor ?? ""),
          keyEndExclusive: `${scope.prefix.slice(0, -1)};`,
          limit: limit + (cursor ? 2 : 1),
          order: "asc",
        });
        const page = rows.filter((row) => row.value.id !== cursor);
        const plans = page.slice(0, limit).map(({ value: plan }) => ({
          id: plan.id,
          title: plan.title,
          scenario: plan.scenario,
          timezone: plan.timezone,
          startDate: plan.startDate,
          endDate: plan.endDate,
          itemCount: plan.items.length,
          jobIds: plan.jobIds,
          updatedAt: plan.updatedAt,
        }));
        return jsonResult({
          plans,
          nextCursor: page.length > limit ? plans.at(-1)?.id : undefined,
        });
      }
      if (input.action === "save") {
        const definition = parsePlan(input.plan);
        const key = scope.prefix + definition.id;
        let observation = await store.observe(key);
        for (let attempt = 0; attempt < 3; attempt++) {
          signal?.throwIfAborted();
          const previous = observation.value;
          const saved: Plan = {
            ...definition,
            jobIds: definition.jobIds ?? previous?.jobIds ?? [],
            progress: previous?.progress ?? {},
            updatedAt: Date.now(),
          };
          const result = await store.compareAndApply(key, observation.comparison, {
            operation: "update",
            action: "set",
            value: saved,
          });
          if (result.status !== "conflict") {
            return jsonResult({
              saved: true,
              plan: saved,
              scheduling: "unchanged; manage native automations separately",
            });
          }
          observation = result.current;
        }
        throw new Error("The plan changed while saving. Read it again and reconcile your edit.");
      }
      if (input.action !== "get" && input.action !== "progress") {
        throw new Error("action must be save, get, list, or progress.");
      }
      const planId = id(input.planId, "planId");
      const key = scope.prefix + planId;
      if (input.action === "get") {
        const plan = await store.lookup(key);
        if (!plan) {
          throw new Error(
            "This plan was not found in the current user's scope. Use list to inspect existing plans.",
          );
        }
        if (input.date === undefined) {
          return jsonResult({ plan });
        }
        const day = date(input.date, "date");
        const items = plan.items
          .filter((item) => occursOn(plan, item, day))
          .map((item) => ({
            ...item,
            progress: plan.progress[`${day}:${item.id}`] ?? { status: "pending" },
          }))
          .sort(
            (a, b) =>
              (a.time ?? "24:00").localeCompare(b.time ?? "24:00") || a.id.localeCompare(b.id),
          );
        return jsonResult({
          planId,
          title: plan.title,
          timezone: plan.timezone,
          date: day,
          jobIds: plan.jobIds,
          items,
          pendingItems: items.filter(
            (item) => item.progress.status !== "completed" && item.progress.status !== "skipped",
          ),
        });
      }
      const day = date(input.date, "date");
      const itemId = id(input.itemId, "itemId");
      const status = statuses.find((candidate) => candidate === input.status);
      if (!status) {
        throw new Error("progress needs status completed, partial, skipped, or pending.");
      }
      const note = input.note === undefined ? undefined : text(input.note, "progress note", 2000);
      let observation = await store.observe(key);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        const plan = observation.value;
        const item = plan?.items.find((candidate) => candidate.id === itemId);
        if (!plan || !item || !occursOn(plan, item, day)) {
          throw new Error(
            "progress needs an existing plan item scheduled for that local date in the current user's scope.",
          );
        }
        const progress: Progress = {
          status,
          ...(note === undefined ? {} : { note }),
          updatedAt: Date.now(),
        };
        const updated: Plan = {
          ...plan,
          progress: { ...plan.progress, [`${day}:${itemId}`]: progress },
          updatedAt: Date.now(),
        };
        const result = await store.compareAndApply(key, observation.comparison, {
          operation: "update",
          action: "set",
          value: updated,
        });
        if (result.status !== "conflict") {
          return jsonResult({ saved: true, planId, itemId, date: day, progress });
        }
        observation = result.current;
      }
      throw new Error(
        "Progress changed while saving. Read the plan again and reconcile your update.",
      );
    },
  };
}
