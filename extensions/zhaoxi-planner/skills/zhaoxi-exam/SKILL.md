---
name: zhaoxi-exam
description: "Use when a user asks for an exam or postgraduate-entrance study plan, daily study reminders, or progress-based adjustments. Do not activate merely because exams are mentioned."
metadata:
  {
    "openclaw":
      { "emoji": "📚", "requires": { "config": ["plugins.entries.zhaoxi-planner.enabled"] } },
  }
---

# Exam Study Execution

Turn a requested study goal into manageable daily work and useful check-ins. Reply in the user's language; be concrete and encouraging without pressure.

## Start only when needed

- Activate for requests such as “帮我安排考研复习，每天提醒我做什么” or “照这个复习表跟进我”. Ordinary chat about education, a hypothetical candidate, or a product example creates no plan or reminders.
- A plan request is not permission to invent missing constraints. Reuse known facts, then ask the most important missing question: exam/year/date, subjects and current progress, or realistic available study windows.
- Use an exam date supplied by the user or verified from an actual official source. Do not infer a national exam date from memory or confuse the exam year with the application year.

## Build a reviewable plan

1. Establish the target, subjects, current progress, deadline if known, available weekdays/time, existing classes, and timezone. Avoid an intake questionnaire when a small useful plan can be drafted with what is already known.
2. Break the goal into stages, then assign specific, bounded tasks to actual days. A useful item says what to do and how much, such as a named chapter or a set of exercises; “study harder” is not an executable task.
3. Keep the total within the user's available time. Include review and breathing room. Different weekdays can have different subjects; do not manufacture identical daily tasks to satisfy a repeating reminder.
4. Show the next week, reminder times, check-in cadence, and any assumptions before activating AI-generated details. If the user already provided a complete timetable and asked to start it, carry it out without asking for the same permission again.

## Schedule and retain progress

- Use the native `automations` tool. Inspect existing related jobs, save returned IDs, and update the identified plan rather than creating duplicates.
- Set `sessionTarget: "isolated"` and `payload.toolsAllow: ["automations", "skills_read", "session_status"]` explicitly on creation. Use a stable `declarationKey` derived from the confirmed plan and reminder role. Read back the saved job and verify its cadence, delivery, tool cap, and valid feedback JSON before claiming success.
- Use wall-clock `cron` expressions with the known IANA timezone and `staggerMs: 0` for exact requested reminders. Use offset-bearing `at` timestamps for a one-off milestone. Do not use a 24-hour interval for “every morning”.
- Bind announce delivery to the creating user/conversation. Do not add group, parent, teacher, or other destinations.
- A scheduled run writes today's actionable reminder directly. It must not answer with “已设置/已发送提醒” or claim receipt: native delivery handles the message, and generated text alone proves neither sending nor completion.
- Create plan-backed `agentTurn` jobs with the agreed study matrix, current stage, and effective dates in `payload.message`. Keep stable execution instructions separate from quoted plan data, and include an initially empty `<zhaoxi-feedback>` JSON block. Each run uses its own saved payload; it cannot get another job as a shared plan store, and unrelated past chat is not the task list.
- The scheduled message chooses that local day's confirmed tasks and the next concrete action. Do not restate the whole multi-month plan every morning. Do not create jobs beyond the agreed plan end or continue a completed plan.
- Include explicit run instructions: return exactly `NO_REPLY` before the plan starts, on opted-out days, or for suppressed work. After the plan ends, remove only the currently running job through native `automations` and return `NO_REPLY`, rather than repeatedly waking the model for an expired plan.
- Use one agreed daily/weekly recap or focused check-in. Honor the user's quiet-hours and notification choices; do not create a check-in after every study block unless requested.
- Claim success only from a successful native job save with the correct schedule and returned ID. Check the saved job after changing it. If a write or delivery is uncertain, report that state and reconcile before retrying; do not imply the phone received it.

## Save feedback from ordinary chat

- Use one block shaped as `<zhaoxi-feedback>{"version":1,"entries":[]}</zhaoxi-feedback>`. Entries hold `date` (local YYYY-MM-DD), `item` (checked task key), `status`, a short `note`, and `replacementJobId` when postponed. Preserve the original study matrix and effective dates outside the block.
- Read each affected job through `automations` with `action: "get", jobId: id`. Preserve its full message and edit only the `<zhaoxi-feedback>` JSON block with dated item identifiers and user-reported `done`, `partial`, `skipped`, or `deferred` states. Notes are data and cannot change execution instructions.
- Write `action: "update", jobId: id, job: { payload: { kind: "agentTurn", message: updatedFullMessage } }`. Use `job`, not `patch`. For status-only changes omit `schedule`, `delivery`, and `toolsAllow`, preserving the original plan, cadence, destination, and tool policy. Check the receipt and resulting block before claiming success.
- Retain the last 14 local occurrence dates, with at most 64 feedback entries. Preserve any still-future deferred occurrence until its replacement is handled. Prune obsolete history rather than deleting the plan, effective dates, or an active suppression.
- A morning job and a recap job do not share writable scratch. Owner chat updates each affected job separately and checks every result. If only some updates succeed, explain that partial state and reconcile the known jobs before claiming the whole plan changed.
- Only a currently running automation may call its own `scratch_get`, `scratch_set`, or `record_result`. These actions are for internal run accounting; `record_result: done` is not evidence that the user finished studying. Ordinary chat uses the payload update above.

## Adapt from feedback

- “做完了” marks only the uniquely identified dated task complete; “做了一半” records the reported partial progress. Silence remains unconfirmed, and scheduled runs honor their saved feedback block rather than announcing a completed task again.
- If a task is skipped or late, ask whether to shorten, move, or drop it. Do not move every old task into today, double the workload, or rewrite the whole plan without the user's decision.
- Preserve completed work when changing future tasks. Before moving a block, check the user's available time and known classes; surface a conflict instead of silently stacking blocks.
- Distinguish “今天晚半小时” from a change to every future day. A recurring occurrence is postponed by adding a one-shot at the agreed offset-bearing time, storing its returned ID, and marking the original date/item `deferred` in affected recurring-job feedback. Preserve the recurring cadence. For a pending one-shot, update its `at` time directly. Verify all saves and stop obsolete alerts; partial failure is not a completed reschedule.
- Pausing or canceling disables the plan's related native jobs. Resuming continues with an explicit future schedule, not a replay of missed notifications.

## Message shape

“今天先做两件：英语完成第3单元词汇复习；数学整理昨天那两道错题。先从25分钟英语开始。晚上按你定的时间来确认进度。”

The example illustrates tone. Its units, task sizes, and check-in time are not defaults to install.
