"""Bounded data projections for the authenticated management console."""

# Only the data and concurrency receipts used by the current web controls.
_SCALARS = {
    "result": "revision preferencesRevision factMemoryPaused shadowOnly deliveryEnabled saved draft discarded deleted id status resent paused confirmRequired requiresExplicitConfirmation confirmationNonce confirmationRevision nonce expiresAt enabled noticeVersion pendingConfirmation cleanupComplete documentCleanupPending",
    "matter": "id revision title summary status deadlineAt timezone submitTo requirements sourceIds createdAt updatedAt completedAt",
    "preparation": "text done",
    "matterReminder": "at text",
    "document": "id title tags excerpt receivedAt bytes",
    "documentFile": "name mime bytes",
    "plan": "id revision status title kind timezone dueAt endAt location notes outdoor weatherCity createdAt updatedAt confirmationNonce confirmationExpiresAt",
    "repeat": "frequency interval weekdays weekParity termStart until",
    "fact": "id revision text sourceKind observedAt confidence automatic status sourceTime sourceAt",
    "factDraft": "id revision text baseRevision createdAt expiresAt confirmationNonce",
    "preferences": "enabled paused timezone quietStart quietEnd greetingLimit cooldownMinutes city interests dailyGreetingEnabled dailyGreetingTime",
    "categories": "reminder weather interest greeting memory",
    "sourceStatus": "weather interest memory",
    "weatherLocation": "city latitude longitude source",
    "followup": "label at expiresAt",
    "proactiveStatus": "lastRefreshAt lastCheckAt memory added deliveryReady",
    "sourceReasons": "weather interest memory dispatch",
    "candidateReason": "category reason",
    "reminder": "id planId category source title at status sentAt deliveryAttemptAt deferUntil",
    "dispatch": "id status createdAt startedAt finishedAt reviewedAt reminderCount",
    "interaction": "active greetingMode activitySampleDays",
    "autoFactMemory": "enabled noticeVersion cityInquiry tombstoneCount",
    "memoryConsent": "noticeVersion at",
    "factSuggestion": "id revision text status confidence createdAt expiresAt sourceTime sourceAt baseRevision",
}
_CHILDREN = {
    "result": {"matters": ("matter", True), "matter": ("matter", False), "documents": ("document", True), "plans": ("plan", True), "plan": ("plan", False), "facts": ("fact", True), "fact": ("fact", False),
               "factDrafts": ("factDraft", True), "factDraft": ("factDraft", False),
               "preferences": ("preferences", False), "availableCategories": ("categories", False), "sourceStatus": ("sourceStatus", False), "proactiveStatus": ("proactiveStatus", False),
               "interactionState": ("interaction", False), "reminders": ("reminder", True), "dispatchAttempts": ("dispatch", True), "autoFactMemory": ("autoFactMemory", False)},
    "plan": {"repeat": ("repeat", False)},
    "matter": {"preparations": ("preparation", True), "reminders": ("matterReminder", True), "history": ("matter", True)},
    "document": {"files": ("documentFile", True)},
    "preferences": {"categories": ("categories", False), "weatherLocation": ("weatherLocation", False)},
    "fact": {"proactive": ("followup", False)},
    "proactiveStatus": {"sources": ("sourceReasons", False), "candidateReasons": ("candidateReason", True)},
    "autoFactMemory": {"consent": ("memoryConsent", False), "suggestions": ("factSuggestion", True)},
}


def public_domain_view(value, kind="result"):
    if not isinstance(value, dict):
        return {}
    result = {key: item for key, item in value.items() if key in _SCALARS[kind].split()}
    for key, (child, many) in _CHILDREN.get(kind, {}).items():
        if key in value:
            item = value[key]
            result[key] = ([public_domain_view(row, child) for row in item] if isinstance(item, list) else []) if many else (
                None if item is None else public_domain_view(item, child))
    return result
