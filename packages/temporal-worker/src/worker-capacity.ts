import { Config, ConfigInvalid, type ConfigField, type ConfigIssue } from "@btravstack/config";
import type { WorkerOptions } from "@temporalio/worker";
import { Err, Ok, type Result } from "unthrown";

type CapacityOptions = Pick<
  WorkerOptions,
  | "maxCachedWorkflows"
  | "maxConcurrentWorkflowTaskExecutions"
  | "maxConcurrentActivityTaskExecutions"
>;

type Capacity = { readonly [K in keyof CapacityOptions]?: CapacityOptions[K] | undefined };

export const capacityFields = (options: Capacity) => ({
  maxCachedWorkflows: Config.pinned(
    options.maxCachedWorkflows,
    optional(Config.integer("TEMPORAL_MAX_CACHED_WORKFLOWS", { min: 0 })),
  ),
  maxConcurrentWorkflowTaskExecutions: Config.pinned(
    options.maxConcurrentWorkflowTaskExecutions,
    optional(Config.integer("TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS", { min: 1 })),
  ),
  maxConcurrentActivityTaskExecutions: Config.pinned(
    options.maxConcurrentActivityTaskExecutions,
    optional(Config.integer("TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS", { min: 1 })),
  ),
});

export const validateCapacity = (
  capacity: Capacity,
  tuner: unknown,
): Result<void, ConfigInvalid> => {
  const issues: ConfigIssue[] = [];
  const { maxCachedWorkflows: cache, maxConcurrentWorkflowTaskExecutions: workflows } = capacity;
  if (cache === 1) {
    issues.push({
      path: ["TEMPORAL_MAX_CACHED_WORKFLOWS"],
      message: "must be zero or at least two",
    });
  }
  if (cache !== 0 && workflows !== undefined && workflows < 2) {
    issues.push({
      path: ["TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS"],
      message: "must be at least two when workflow caching is enabled",
    });
  }
  if (cache !== undefined && cache > 0 && workflows !== undefined && workflows > cache) {
    issues.push({
      path: ["TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS"],
      message: "must not exceed TEMPORAL_MAX_CACHED_WORKFLOWS when caching is enabled",
    });
  }
  if (tuner !== undefined) {
    issues.push({
      path: ["tuner"],
      message: "custom tuners are not supported; use the named capacity options",
    });
  }
  return issues.length === 0
    ? Ok(undefined)
    : Err(new ConfigInvalid({ port: "TemporalConfig", issues }));
};

export const capacityOptions = (capacity: Capacity): CapacityOptions => ({
  ...(capacity.maxCachedWorkflows === undefined
    ? {}
    : { maxCachedWorkflows: capacity.maxCachedWorkflows }),
  ...(capacity.maxConcurrentWorkflowTaskExecutions === undefined
    ? {}
    : { maxConcurrentWorkflowTaskExecutions: capacity.maxConcurrentWorkflowTaskExecutions }),
  ...(capacity.maxConcurrentActivityTaskExecutions === undefined
    ? {}
    : { maxConcurrentActivityTaskExecutions: capacity.maxConcurrentActivityTaskExecutions }),
});

const optional = <const V extends string>(
  field: ConfigField<number, V>,
): ConfigField<number | undefined, V, "optional"> => ({
  variable: field.variable,
  parse: (raw) => (raw === undefined ? Ok(undefined) : field.parse(raw)),
  check: (value) => (value === undefined ? Ok(undefined) : field.check!(value)),
});
