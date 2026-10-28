import { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "zhaoxi-planner",
  name: "朝夕",
  description: "User-requested plans, reminders, campus, exam and fitness execution.",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "zhaoxi_plan",
          label: "朝夕计划",
          description:
            "Save, read and track only the user's requested campus, exam or fitness plan. Saving does not schedule notifications. Use native automations only after a concrete user request for reminders.",
          parameters: planParameters,
          execute: async (id, input, signal) => {
            const { createPlanTool } = await import("./src/plans.js");
            return createPlanTool(api, context).execute(id, input, signal);
          },
        }),
      },
      { name: "zhaoxi_plan", workspaceAccess: false },
    );
  },
});

import { planParameters } from "./src/plan-schema.js";
