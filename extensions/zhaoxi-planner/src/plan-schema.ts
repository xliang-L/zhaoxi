export const planIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const planDatePattern = /^\d{4}-\d{2}-\d{2}$/;
export const planTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const planProgressStatuses = ["completed", "partial", "skipped", "pending"] as const;
export const planScenarios = ["campus", "exam", "fitness"] as const;
const dateSchema = { type: "string", pattern: planDatePattern.source };
const timeSchema = { type: "string", pattern: planTimePattern.source };
const idSchema = { type: "string", pattern: planIdPattern.source };
const itemSchema = {
  type: "object",
  properties: {
    id: idSchema,
    title: { type: "string", minLength: 1, maxLength: 500 },
    date: dateSchema,
    weekdays: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 7 },
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      description: "Recurring weekdays, Monday=1 through Sunday=7. Use either date or weekdays.",
    },
    time: timeSchema,
    endTime: timeSchema,
    location: { type: "string", maxLength: 500 },
    course: { type: "string", maxLength: 200 },
    dueAt: {
      type: "string",
      maxLength: 64,
      description: "Exact assignment deadline as an ISO timestamp with explicit UTC offset.",
    },
    weeks: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 54 },
      minItems: 1,
      maxItems: 54,
      uniqueItems: true,
      description: "Active course week numbers; requires semesterStart, the first Monday.",
    },
    semesterStart: dateSchema,
    excludedDates: { type: "array", items: dateSchema, maxItems: 366, uniqueItems: true },
    minutes: { type: "integer", minimum: 1, maximum: 1440 },
  },
  required: ["id", "title"],
  additionalProperties: false,
};
export const planParameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["save", "get", "list", "progress"] },
    plan: {
      type: "object",
      properties: {
        id: idSchema,
        title: { type: "string", minLength: 1, maxLength: 500 },
        scenario: { type: "string", enum: planScenarios },
        timezone: { type: "string", minLength: 1, maxLength: 100 },
        startDate: dateSchema,
        endDate: dateSchema,
        items: { type: "array", items: itemSchema, minItems: 1, maxItems: 200 },
        jobIds: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 200 },
          maxItems: 100,
          uniqueItems: true,
        },
      },
      required: ["id", "title", "scenario", "timezone", "items"],
      additionalProperties: false,
    },
    planId: idSchema,
    date: dateSchema,
    itemId: idSchema,
    status: { type: "string", enum: planProgressStatuses },
    note: { type: "string", maxLength: 2000 },
    cursor: { ...idSchema, description: "Last plan ID returned by the previous list page." },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["action"],
  additionalProperties: false,
};
