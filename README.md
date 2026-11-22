# FirstProject issue API and triage webhook

A small Node.js service that creates GitHub issues through a REST API and triages newly opened issues through a GitHub webhook.

## What it does

- `POST /api/issues` creates an issue in `rameshhugar184-design/FirstProject`.
- The signed GitHub webhook listens for newly opened issues and categorizes matching reports:
  - **Server not responding** → adds `server-not-responding`, optionally assigns configured GitHub users, and mentions the configured L2 team.
  - **Data not available** → adds `data-not-available`, optionally assigns configured GitHub users, and mentions the configured Tech team.
- If a verified resolution is configured in `src/solutions.json`, it posts the steps as a comment.
- Otherwise, it adds `human-action-required` and comments that human investigation is needed. It does not invent remediation steps.
- Other issue types are marked `needs-triage` and require human review.

GitHub issue assignees are user accounts, not arbitrary team names. This service can assign usernames with the `*_ASSIGNEES` settings and mention teams in the issue comment with `*_TEAM_MENTION`. Since this repository is owned by a personal account, organization team assignment/mentions may not be available unless the repository is transferred to or managed by an organization.

## Run locally

Requires Node.js 20 or newer.

1. Install dependencies: `npm install`.
2. Copy `.env.example` to `.env` and set `GITHUB_TOKEN`, `API_KEY`, and a strong `GITHUB_WEBHOOK_SECRET`.
3. Set `GITHUB_TOKEN` to a fine-grained token with **Issues: read and write** access to this repository. Do not commit `.env` or expose these secrets in a client app.
4. Configure optional GitHub usernames and team mentions in `.env`. Usernames must have access to the repository.
5. Start with `npm start`.

## Create an issue using the REST API

Send the API key as a bearer token. Example:

```bash
curl -X POST http://localhost:3000/api/issues \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Server not responding on checkout","body":"Requests time out."}'
```

The API responds with the created issue number and URL. It creates issues only; the webhook handles triage after GitHub emits the `issues.opened` event.

## Configure the GitHub webhook

In the repository, open **Settings → Webhooks → Add webhook**:

- **Payload URL:** your publicly reachable service URL plus `/webhooks/github`
- **Content type:** `application/json`
- **Secret:** exactly the value of `GITHUB_WEBHOOK_SECRET`
- **Events:** select **Issues** (the service processes only `opened`)

The deployed service must be reachable over HTTPS. For local testing, use a trusted tunneling service and do not publish secrets. Set the webhook to active and check its recent deliveries if events are not received.

## Add known solutions

Only add steps that have been reviewed and verified by your support/engineering team. Edit `src/solutions.json`; values are arrays of steps. An empty array intentionally triggers human escalation.

```json
{
  "server_not_responding": ["Example verified step 1", "Example verified step 2"],
  "data_not_available": []
}
```

The example steps above are placeholders, not actual troubleshooting guidance. Commit your verified steps before deployment.

## Deploy and operate

Deploy the service to a trusted Node.js host, set the environment variables in the host's secret manager, and configure the webhook URL. Keep the service private/restricted where possible, use a strong API key and webhook secret, and rotate credentials if exposed. The GitHub token should be limited to this repository and the minimum required permission. `GET /health` is a basic health check.
