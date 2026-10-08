import { printSchema } from "graphql";

import { orderGraphqlSchema } from "./graphql-schema.js";

process.stdout.write(`${printSchema(orderGraphqlSchema)}\n`);
