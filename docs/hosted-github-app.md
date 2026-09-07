# Hosted GitHub account connection

LocalMesh can be installed once as a GitHub App on a personal account or organization. The installer chooses all repositories or a selected set. Pull request, merge queue, repository, and default-branch push webhooks then enter one hosted control plane and appear in a tenant-scoped dashboard.

## Hosted request path

1. The dashboard sends the user to `/auth/github` on the API.
2. The API performs GitHub user authorization with a signed, browser-bound state value, stores the encrypted user token, and creates a signed HTTP-only session.
3. `/api/github/install-url` returns the GitHub App installation URL with a second signed state value.
4. GitHub redirects the installer to `/github/setup`. The API verifies the state, session, and installation against GitHub's user-installation API before linking it.
5. Installation and repository access are stored in `github_installations`, `installation_repositories`, and `user_installations`.
6. GitHub sends signed webhooks to `/webhooks/github`. Delivery IDs are claimed once so retries cannot duplicate work.
7. PR events create validation jobs immediately. Default-branch pushes enqueue repository discovery and fan out through the worker so the webhook can return quickly.
8. Workers use short-lived installation tokens, run migrations in isolated PostgreSQL containers, write GitHub Checks and direct-PR sticky comments, and store evidence for the dashboard.

Jobs and installation APIs use the signed session to restrict every query to installations linked to the current GitHub user. An installation callback ID alone never grants dashboard access.

## Deploy on a cloud VM

The hosted Compose bundle runs the API, dashboard, metadata PostgreSQL, validation worker, and an HTTPS Caddy gateway. The VM needs Linux, Docker Engine, Compose, outbound GitHub access, and DNS records for the app and API domains.

```bash
cp deploy/hosted/.env.hosted.example deploy/hosted/.env.hosted
docker compose --env-file deploy/hosted/.env.hosted -f deploy/hosted/docker-compose.yml up -d --build
```

Use long random values for the PostgreSQL password, webhook secret, session secret, and optional Action-ingestion secret. Keep `.env.hosted` and the GitHub private key out of Git. Point both DNS names at the VM before starting Caddy so it can obtain certificates.

## Register the GitHub App

Create the App from `.github/localmesh-app-manifest.example.json` after replacing the example hosts. The deployed values must agree:

| GitHub setting | Hosted endpoint |
| --- | --- |
| Homepage | `https://app.example.com` |
| Callback URL | `https://api.example.com/auth/github/callback` |
| Setup URL | `https://api.example.com/github/setup` |
| Webhook URL | `https://api.example.com/webhooks/github` |

Configure the returned App ID, client ID, client secret, private key, slug, bot login, and webhook secret in `.env.hosted`. Restart the API and worker after changing them.

The required repository permissions are Contents read, Pull requests read, Checks write, Issues write, and Metadata read. Subscribe to Pull request, Merge group, Push, and Repository events. Installation and installation-repository lifecycle events are delivered to GitHub Apps automatically.

Use a private App for one owner account. Make it public when unrelated GitHub accounts should be able to install it. Public visibility does not grant repository access; each account still chooses all or selected repositories during installation.

## Repository behavior

The default migration directory is `db/migrations`. A repository can commit `localmesh.yml` to change the directory and validation policy. Direct PR updates receive a Check and one sticky comment. A default-branch push rechecks every open migration PR with Checks only. Merge queue events validate the cumulative queue revision.

The GitHub Action and GitHub App are alternative transports. Remove the repository workflows when the App is installed so two publishers do not create the same required check.
