import yaml from "js-yaml";
import { z } from "zod";

export const migrationAdapterNames=["raw-sql","prisma","drizzle","flyway","liquibase","rails","django","alembic"] as const;
export type MigrationAdapterName=typeof migrationAdapterNames[number];

const schema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  postgres: z.object({
    version: z.enum(["14", "15", "16", "17"]).default("16"),
    extensions: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default([])
  }),
  migrations: z.object({
    directory: z.string().min(1).default("db/migrations"),
    up_pattern: z.string().default("*.up.sql"),
    down_pattern: z.string().default("*.down.sql"),
    adapter: z.enum(migrationAdapterNames).default("raw-sql")
  }),
  contracts: z.object({
    mappings_file: z.string().default(".localmesh/contracts.yml"),
    fixtures_directory: z.string().default(".localmesh/fixtures")
  }).default({ mappings_file: ".localmesh/contracts.yml", fixtures_directory: ".localmesh/fixtures" }),
  checks: z.object({
    compare_open_pull_requests: z.boolean().default(true),
    verify_rollback: z.boolean().default(true),
    require_data_contracts: z.boolean().default(false),
    compare_fixture_state: z.boolean().default(true),
    max_group_size: z.number().int().min(2).max(3).default(3),
    max_group_permutations: z.number().int().min(0).max(120).default(20)
  }).default({ compare_open_pull_requests: true, verify_rollback: true, require_data_contracts: false, compare_fixture_state: true, max_group_size: 3, max_group_permutations: 20 }),
  data_state: z.object({
    exclude_columns: z.array(z.string().regex(/^[a-zA-Z_][\w$]*\.[a-zA-Z_][\w$]*\.[a-zA-Z_][\w$]*$/)).max(200).default([]),
    max_differences: z.number().int().min(1).max(100).default(20)
  }).default({ exclude_columns: [], max_differences: 20 }),
  performance: z.object({ metadata_file:z.string().default(".localmesh/metadata.json") }).default({metadata_file:".localmesh/metadata.json"}),
  ai: z.object({ provider: z.literal("ollama"), model: z.string().min(1) }).optional()
});

export type LocalMeshConfig = z.infer<typeof schema>;

export function parseConfig(source: string): LocalMeshConfig {
  return schema.parse(yaml.load(source));
}

export const defaultConfig: LocalMeshConfig = schema.parse({
  version: 1,
  postgres: { version: "16", extensions: [] },
  migrations: { directory: "db/migrations", up_pattern: "*.up.sql", down_pattern: "*.down.sql" }
});

const metadataSchema=z.array(z.object({relation:z.string().regex(/^[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?$/),estimatedRows:z.number().nonnegative().optional(),bytes:z.number().nonnegative().optional(),indexes:z.array(z.string()).optional()}));
export type OperationalMetadata=z.infer<typeof metadataSchema>;
export const parseOperationalMetadata=(source:string):OperationalMetadata=>metadataSchema.parse(JSON.parse(source));
