import { ConfigFieldInvalid, type ConfigField } from "@btravstack/config";
import { Err, Ok, type Result } from "unthrown";

export const logoutRedirectUri = <V extends string>(
  variable: V,
): ConfigField<string | undefined, V, "optional"> => ({
  variable,
  parse: (raw) => validate(raw?.trim()),
  check: validate,
});

function validate(value: string | undefined): Result<string | undefined, ConfigFieldInvalid> {
  if (value === undefined) return Ok(undefined);
  const url = URL.parse(value);
  return url === null ||
    [...value].some((character) => character <= " " || character === "\u007f") ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#")
    ? Err(
        new ConfigFieldInvalid({
          reason: "must be an absolute HTTP(S) URI without credentials or a fragment",
        }),
      )
    : Ok(value);
}
