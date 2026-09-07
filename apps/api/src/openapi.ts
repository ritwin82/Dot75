export function openApiDocument(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "LocalMesh Sensei API",
      version: "0.1.0",
      description: "Tenant-scoped migration compatibility evidence. GitHub Checks remain the authoritative merge gate."
    },
    servers: [{ url: origin }],
    paths: {
      "/health": { get: { operationId: "getHealth", responses: { "200": { description: "Service status" } } } },
      "/health/live": { get: { operationId: "getLiveness", responses: { "200": { description: "API process is alive" } } } },
      "/health/ready": { get: { operationId: "getReadiness", responses: { "200": { description: "Database and queue are ready" }, "503": { description: "A required dependency is unavailable" } } } },
      "/metrics": { get: { operationId: "getMetrics", responses: { "200": { description: "Prometheus validation-job metrics" } } } },
      "/api/jobs": { get: { operationId: "listValidationJobs", security: [{ githubSession: [] }], responses: { "200": { description: "Recent validation jobs" } } } },
      "/api/jobs/{id}": { get: { operationId: "getValidationJob", security: [{ githubSession: [] }], parameters: [{ $ref: "#/components/parameters/JobId" }], responses: { "200": { description: "Stored validation result" }, "404": { $ref: "#/components/responses/NotFound" } } } },
      "/api/jobs/{id}/events": { get: { operationId: "streamJobEvents", security: [{ githubSession: [] }], description: "Use Accept: text/event-stream for SSE or omit it for polling JSON.", parameters: [{ $ref: "#/components/parameters/JobId" }, { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }], responses: { "200": { description: "SSE job-stage events or a JSON event page" } } } },
      "/api/jobs/{id}/export/{format}": { get: { operationId: "exportValidationResult", security: [{ githubSession: [] }], parameters: [{ $ref: "#/components/parameters/JobId" }, { name: "format", in: "path", required: true, schema: { enum: ["json", "markdown", "sarif", "junit"] } }], responses: { "200": { description: "Validation evidence in a portable format" } } } },
      "/api/repositories/{owner}/{repo}/compatibility": { get: { operationId: "getRepositoryCompatibility", security: [{ githubSession: [] }], responses: { "200": { description: "Latest immutable PR compatibility graph" } } } },
      "/api/repositories/{owner}/{repo}/recurrence": { get: { operationId: "getRepositoryRecurrence", security: [{ githubSession: [] }], responses: { "200": { description: "Recurring migration findings" } } } }
    },
    components: {
      securitySchemes: { githubSession: { type: "apiKey", in: "cookie", name: "localmesh_session" } },
      parameters: { JobId: { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } } },
      responses: { NotFound: { description: "Resource not found" } }
    }
  } as const;
}
