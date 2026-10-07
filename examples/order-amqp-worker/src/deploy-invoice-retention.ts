import { createLogger, jsonSink } from "@btravstack/observability";

import { ensureInvoiceRetention } from "./invoice-retention.js";

const logger = createLogger(jsonSink());

const ensured = await ensureInvoiceRetention(process.env)
  .tap(() => logger.info("the invoice lifecycle rule is in place"))
  .tapFailure((failure) =>
    logger.error(
      "the invoice lifecycle rule was not installed",
      {},
      failure.tag === "Err" ? failure.error : failure.cause,
    ),
  );

process.exitCode = ensured.isOk() ? 0 : 1;
