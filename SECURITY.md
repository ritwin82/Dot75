# Security model

- Verify every GitHub webhook with HMAC-SHA256 before parsing or enqueueing it.
- Store GitHub App private keys and webhook secrets only in environment-backed secret storage.
- Use installation tokens only through Octokit and never persist them in job results or logs.
- Treat repository SQL as untrusted code. Workers must run on isolated infrastructure with disposable databases and no production network credentials.
- Do not expose the Docker socket through the public API service. Only the worker receives it.
- Restrict the dashboard and API to the operator's trusted environment; the MVP does not implement user authentication.
- Configure container CPU, memory, process, and execution time limits before using LocalMesh with untrusted repositories in production.
- Report vulnerabilities privately to the repository owner rather than opening a public issue.
