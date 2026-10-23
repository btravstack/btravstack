import { Config, ConfigFieldInvalid, type ConfigField } from "@btravstack/config";
import { defineContract, type ContractDefinition } from "@temporal-contract/contract";
import { fromThrowable } from "unthrown";

export const taskQueueField = (
  contract: ContractDefinition,
): ConfigField<string, "TEMPORAL_TASK_QUEUE", "optional"> => {
  const field = Config.string("TEMPORAL_TASK_QUEUE", { default: contract.taskQueue });
  const check = (taskQueue: string) =>
    fromThrowable(
      () => defineContract({ ...contract, taskQueue }).taskQueue,
      (cause) => new ConfigFieldInvalid({ reason: String(cause) }),
    )();
  return { variable: field.variable, parse: (raw) => field.parse(raw).flatMap(check), check };
};
