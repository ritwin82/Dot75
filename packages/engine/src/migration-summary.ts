import type { MigrationFile, MigrationOperationSummary, ObjectKind, PullRequestChangeSummary, SchemaObject } from "@localmesh/shared";

const identifier = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\.(?:"[^"]+"|[a-zA-Z_][\w$]*))?`;
const clean = (value: string): string => value.replaceAll('"', "").replace(/\s+/g, " ").trim();

function operation(file: string, action: MigrationOperationSummary["action"], objectKind: MigrationOperationSummary["objectKind"], objectName: string, description: string): MigrationOperationSummary {
  return { file, action, objectKind, objectName: clean(objectName), description };
}

export function summarizeMigrationOperations(files: MigrationFile[]): MigrationOperationSummary[] {
  const operations: MigrationOperationSummary[] = [];
  for (const file of files.filter((candidate) => candidate.direction === "up")) {
    const statements = file.sql.split(";").map((statement) => statement.trim()).filter(Boolean);
    for (const rawStatement of statements) {
      const statement = rawStatement.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
      if (!statement) continue;
      let match: RegExpMatchArray | null;
      if ((match = statement.match(new RegExp(`^CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "create", "table", match[1]!, `Creates table ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ADD\\s+CONSTRAINT\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "add", "constraint", `${match[1]}.${match[2]}`, `Adds constraint ${clean(match[2]!)} to ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+DROP\\s+CONSTRAINT(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "drop", "constraint", `${match[1]}.${match[2]}`, `Drops constraint ${clean(match[2]!)} from ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ADD(?:\\s+COLUMN)?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "add", "column", `${match[1]}.${match[2]}`, `Adds column ${clean(match[2]!)} to ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+RENAME\\s+COLUMN\\s+(${identifier})\\s+TO\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "rename", "column", `${match[1]}.${match[2]}`, `Renames ${clean(match[1]!)}.${clean(match[2]!)} to ${clean(match[3]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+DROP(?:\\s+COLUMN)?(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "drop", "column", `${match[1]}.${match[2]}`, `Drops column ${clean(match[2]!)} from ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ALTER(?:\\s+COLUMN)?\\s+(${identifier})\\s+SET\\s+DEFAULT\\s+([\\s\\S]+)$`, "i")))) {
        const value=clean(match[3]!).slice(0,160);
        operations.push(operation(file.path, "alter", "column", `${match[1]}.${match[2]}`, `Sets the default value of ${clean(match[1]!)}.${clean(match[2]!)} to ${value}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ALTER(?:\\s+COLUMN)?\\s+(${identifier})\\s+DROP\\s+DEFAULT`, "i")))) {
        operations.push(operation(file.path, "alter", "column", `${match[1]}.${match[2]}`, `Removes the default value from ${clean(match[1]!)}.${clean(match[2]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ALTER(?:\\s+COLUMN)?\\s+(${identifier})\\s+(SET|DROP)\\s+NOT\\s+NULL`, "i")))) {
        operations.push(operation(file.path, "alter", "column", `${match[1]}.${match[2]}`, `${match[3]!.toUpperCase()==="SET"?"Requires":"Allows"} null values for ${clean(match[1]!)}.${clean(match[2]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ALTER(?:\\s+COLUMN)?\\s+(${identifier})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+([^\\s,]+)`, "i")))) {
        operations.push(operation(file.path, "alter", "column", `${match[1]}.${match[2]}`, `Changes ${clean(match[1]!)}.${clean(match[2]!)} to type ${clean(match[3]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})\\s+ALTER(?:\\s+COLUMN)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "alter", "column", `${match[1]}.${match[2]}`, `Changes the definition of ${clean(match[1]!)}.${clean(match[2]!)}.`));
      } else if ((match = statement.match(new RegExp(`^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "alter", "table", match[1]!, `Changes table ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^CREATE(?:\\s+UNIQUE)?\\s+INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${identifier})\\s+ON\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "create", "index", match[1]!, `Creates index ${clean(match[1]!)} on ${clean(match[2]!)}.`));
      } else if ((match = statement.match(new RegExp(`^DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "drop", "table", match[1]!, `Drops table ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^INSERT\\s+INTO\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "insert", "data", match[1]!, `Inserts rows into ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^UPDATE\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "update", "data", match[1]!, `Updates rows in ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^DELETE\\s+FROM\\s+(${identifier})`, "i")))) {
        operations.push(operation(file.path, "delete", "data", match[1]!, `Deletes rows from ${clean(match[1]!)}.`));
      } else if ((match = statement.match(new RegExp(`^CREATE(?:\\s+OR\\s+REPLACE)?\\s+(VIEW|FUNCTION|TYPE)\\s+(${identifier})`, "i")))) {
        const kind = match[1]!.toLowerCase() as "view" | "function" | "type";
        operations.push(operation(file.path, "create", kind, match[2]!, `Creates or replaces ${kind} ${clean(match[2]!)}.`));
      } else {
        operations.push(operation(file.path, "execute", "statement", file.path, "Runs an additional database statement; inspect the migration for its exact effect."));
      }
    }
  }
  return operations.slice(0, 100);
}

export function summarizePullRequestChange(pr: number, files: MigrationFile[], affectedObjects: SchemaObject[]): PullRequestChangeSummary {
  return {
    pr,
    migrationFiles: files.map((file) => file.path),
    operations: summarizeMigrationOperations(files),
    affectedObjects: affectedObjects.map(({ id, kind }) => ({ id, kind: kind as ObjectKind }))
  };
}
