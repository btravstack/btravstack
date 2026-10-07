import { createLogger, jsonSink } from "@btravstack/observability";

import { deploySchedules } from "./schedules.js";

const logger = createLogger(jsonSink());

const deployed = await deploySchedules(process.env)
  .tap(({ ensured, retired }) =>
    logger.info("the sweep schedules are ensured", {
      ensured: ensured.join(","),
      retired: retired.join(","),
    }),
  )
  .tapFailure((failure) =>
    logger.error(
      "the sweep schedules were not ensured",
      {},
      failure.tag === "Err" ? failure.error : failure.cause,
    ),
  );

process.exitCode = deployed.isOk() ? 0 : 1;
