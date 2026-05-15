// Migrated from ~/.claude/hooks/learnings-stop.sh.
// Claude Code can block Stop; OpenCode plugins cannot exactly block session idle.
// This plugin logs an idle reminder and exposes the same prompt via /learnings.

export const LearningsReminderPlugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      await client.app.log({
        body: {
          service: "learnings-reminder",
          level: "info",
          message:
            "Session idle. If this was a substantial work session, update learnings.md using /Users/psbakre/.claude/hooks/learnings-prompt.txt.",
        },
      });
    },
  };
};
