# Slack Deployment Identity

Junior treats the Slack token's deployment identity as separate from agent
persona identities (`Junior`, `Reviewer`, and overlay workers).

`src/slack/deployment-identity.ts` resolves the token with `auth.test`, obtains
the visible app/user name via `users.info`, and paginates public/private
conversations to collect channels where the token is a member. Startup compares
that result against `SLACK_EXPECTED_*` values or the mode-0600 persisted pin at
`SLACK_DEPLOYMENT_IDENTITY_PATH`. A mismatch, missing pin, failed API call, or
missing expected channel stops event-handler registration and exits non-zero.

Use the explicit setup/doctor commands after authenticating the intended bot:

```sh
SLACK_BOT_TOKEN=xoxb-... bun run slack:identity:setup
SLACK_BOT_TOKEN=xoxb-... bun run slack:identity:doctor
```

`SLACK_EXPECTED_CHANNEL_IDS` can constrain setup/doctor to the channels the
deployment must join. Explicit environment pins override the persisted file,
which makes a deployment swap visible instead of silently adopting the new
token.
