import { parseMappings } from "@localmesh/contracts";
import type { MigrationFile } from "@localmesh/shared";
import type { ValidationPlan } from "./validation-plan.js";

const up = (sql: string, order: number): MigrationFile => ({ path: `db/migrations/00${order}_demo.up.sql`, sql, order, direction: "up" });
const down = (sql: string, order: number): MigrationFile => ({ path: `db/migrations/00${order}_demo.down.sql`, sql, order, direction: "down" });
const baseline = [up("CREATE TABLE orders (id bigint PRIMARY KEY, user_id bigint, status text NOT NULL DEFAULT 'created'); CREATE TABLE users (id bigint PRIMARY KEY);", 1)];
const inventory = parseMappings("version: 1\nmappings:\n  - template: inventory\n    bindings: { table: public.inventory, product_id: product_id, quantity: quantity }\n");
const orders = parseMappings("version: 1\nmappings:\n  - template: orders\n    bindings: { table: public.orders, id: id, customer_id: user_id, status: status }\n");
export interface DemoScenario { name: string; plan: ValidationPlan; expectedCode?: string; expectedPassed: boolean; singlesPass: boolean }
function pair(name: string, a: string, undoA: string, b: string, undoB: string, pr: number, code: string): DemoScenario {
  return { name, expectedCode: code, expectedPassed: false, singlesPass: true, plan: { baseline, current: { pr, files: [up(a, 2), down(undoA, 2)] }, candidates: [{ pr: pr + 1, files: [up(b, 3), down(undoB, 3)] }], extensions: [], fixtures: [], requireDataContracts: false, verifyRollback: true } };
}
const schema = pair("required-status-contract", "ALTER TABLE orders DROP COLUMN status;", "ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'created';", "ALTER TABLE orders ADD COLUMN archived_at timestamptz;", "ALTER TABLE orders DROP COLUMN archived_at;", 207, "CONTRACT_COLUMN_MISSING");
schema.plan.mappings = orders;
schema.singlesPass = false;
const data = pair("inventory-contract-collision", "UPDATE inventory SET quantity = quantity - 6;", "UPDATE inventory SET quantity = quantity + 6;", "UPDATE inventory SET quantity = quantity - 6;", "UPDATE inventory SET quantity = quantity + 6;", 209, "DATA_CONTRACT_FAILED");
data.plan.baseline = [up("CREATE TABLE inventory (product_id bigint PRIMARY KEY, quantity integer NOT NULL);", 1)];
data.plan.fixtures = ["INSERT INTO inventory(product_id, quantity) VALUES (1, 10);"];
data.plan.mappings = inventory;
data.plan.requireDataContracts = true;
// Data-only changes have no catalog diff; enabled data contracts must keep this pair in scope.
const safe = pair("compatible-three-pr-control", "ALTER TABLE orders ADD COLUMN note text;", "ALTER TABLE orders DROP COLUMN note;", "ALTER TABLE orders ADD COLUMN archived_at timestamptz;", "ALTER TABLE orders DROP COLUMN archived_at;", 211, "");
delete safe.expectedCode;
safe.expectedPassed = true;
safe.plan.candidates.push({ pr: 213, files: [up("ALTER TABLE users ADD COLUMN nickname text;", 4)] });

export const demoScenarios: DemoScenario[] = [
  pair("duplicate-column", "ALTER TABLE orders ADD COLUMN priority integer;", "ALTER TABLE orders DROP COLUMN priority;", "ALTER TABLE orders ADD COLUMN priority text;", "ALTER TABLE orders DROP COLUMN priority;", 201, "42701"),
  pair("drop-versus-index", "ALTER TABLE orders DROP COLUMN status;", "ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'created';", "CREATE INDEX orders_status_idx ON orders(status);", "DROP INDEX orders_status_idx;", 203, "42703"),
  pair("conflicting-defaults", "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'paid';", "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'created';", "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'cancelled';", "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'created';", 205, "ORDER_SCHEMA_DIVERGENCE"),
  schema, data, safe
];
