import { Err, Ok, type Result } from "unthrown";

import { InvalidStorageOptions } from "./storage.js";

export const validateOptions = (
  key: string,
  options: {
    readonly sha256?: string;
    readonly metadata?: Readonly<Record<string, string>>;
  },
): Result<void, InvalidStorageOptions> => {
  if (options.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.sha256)) {
    return Err(new InvalidStorageOptions({ key, reason: "invalid_sha256" }));
  }
  if (
    Object.keys(options.metadata ?? {}).some((name) => !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name))
  ) {
    return Err(new InvalidStorageOptions({ key, reason: "invalid_metadata_key" }));
  }
  return Ok();
};
