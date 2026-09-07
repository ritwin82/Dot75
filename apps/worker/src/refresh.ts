import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { cancelStaleJobs, saveJob, setCheckRunId } from "@localmesh/db";
import { cancelCheck, createCheck, discoverMigrationPullRequests, getTextFile, installationClient } from "@localmesh/github";
import { defaultConfig, parseConfig, type RepositoryRefreshJob, type ValidationJob } from "@localmesh/shared";

export async function refreshRepository(boss: PgBoss, refresh: RepositoryRefreshJob): Promise<number> {
  const client = await installationClient(refresh.installationId);
  const configText = await getTextFile(client, refresh.owner, refresh.repo, "localmesh.yml", refresh.baseSha);
  const config = configText === undefined ? defaultConfig : parseConfig(configText);
  const discovered = await discoverMigrationPullRequests(client, {
    owner: refresh.owner, repo: refresh.repo, baseSha: refresh.baseSha, baseRef: refresh.baseRef,
    directory: config.migrations.directory, includeDrafts: true
  });
  let queued = 0;
  for (const pullRequest of discovered.pullRequests) {
    const stale = await cancelStaleJobs(refresh.owner, refresh.repo, pullRequest.number, pullRequest.headSha);
    await Promise.all(stale.flatMap((old) => old.checkRunId ? [cancelCheck(client, refresh.owner, refresh.repo, old.checkRunId)] : []));
    const job: ValidationJob = {
      id: randomUUID(), installationId: refresh.installationId, owner: refresh.owner, repo: refresh.repo,
      prNumber: pullRequest.number, headSha: pullRequest.headSha, baseSha: refresh.baseSha, trigger: "push"
    };
    if (!await saveJob(job)) continue;
    const checkRunId = await createCheck(client, refresh.owner, refresh.repo, pullRequest.headSha);
    job.checkRunId = checkRunId;
    await setCheckRunId(job.id, checkRunId);
    await boss.send("validate-pr", job, { singletonKey: `${refresh.owner}/${refresh.repo}#${pullRequest.number}:${pullRequest.headSha}:${refresh.baseSha}` });
    queued++;
  }
  return queued;
}
