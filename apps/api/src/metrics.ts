export function renderMetrics(statuses:Array<{status:string;count:string|number}>,activeRemediations:number):string {
  const lines=["# HELP dot75_validation_jobs Validation jobs by current state.","# TYPE dot75_validation_jobs gauge"];
  for(const row of statuses){const status=row.status.replace(/[^a-zA-Z0-9_-]/g,"_");lines.push(`dot75_validation_jobs{status="${status}"} ${Number(row.count)}`);}
  lines.push("# HELP dot75_active_remediations Remediation attempts currently executing.","# TYPE dot75_active_remediations gauge",`dot75_active_remediations ${activeRemediations}`);
  return `${lines.join("\n")}\n`;
}
