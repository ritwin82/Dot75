# Security model

- Verify every GitHub webhook with HMAC-SHA256 before parsing or enqueueing it.
- Store GitHub App private keys and webhook secrets only in environment-backed secret storage.
- Use installation tokens only through Octokit and never persist them in job results or logs.
- Treat repository SQL as untrusted code. Workers must run on isolated infrastructure with disposable databases and no production network credentials.
- Do not expose the Docker socket through the public API service. Only the worker receives it.
- The contract editor and remediation lab require encrypted HTTP-only GitHub OAuth sessions, CSRF tokens, and live repository permission checks. Keep `SESSION_SECRET` in the deployment secret store.
- GitHub App delivery rejects public repositories. Action delivery requires the operator-controlled `DOT75_ALLOW_PUBLIC_REPOSITORY=true` opt-in for public repositories; a pull request cannot set it through Dot75 configuration.
- Validation databases use per-run non-superuser roles, client/server statement timeouts, tmpfs storage, and bounded CPU/memory defaults. Keep the Docker daemon and worker on dedicated trusted infrastructure; access to the Docker socket is root-equivalent.
- Run the API and web containers read-only with dropped Linux capabilities and no-new-privileges, as shown in the production Compose baseline.
- Report vulnerabilities privately to the repository owner rather than opening a public issue.
