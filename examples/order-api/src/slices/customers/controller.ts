import { customersContract } from "@btravstack/example-order-api-contract";
import { HttpController } from "@btravstack/http";
import { P } from "unthrown";

import { CustomerDirectory } from "./directory.js";

export const customersController = HttpController("CustomersController", customersContract)(
  [CustomerDirectory],
  {
    sync: (directory) => ({
      find: ({ errors }, input) =>
        directory
          .find(input.id)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("CustomerNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);
