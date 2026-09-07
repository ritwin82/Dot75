import {describe,expect,it} from "vitest";
import {renderMetrics} from "./metrics.js";
describe("Prometheus metrics",()=>it("renders bounded labels and numeric values",()=>expect(renderMetrics([{status:'run"ning',count:"2"}],1)).toContain('dot75_validation_jobs{status="run_ning"} 2')));
