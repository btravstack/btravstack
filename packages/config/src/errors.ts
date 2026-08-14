import { TaggedError } from "unthrown";

/** One wrong variable, already named the way the environment names it. */
export type ConfigIssue = {
  readonly variable: string;
  readonly message: string;
};

/**
 * Every wrong variable in one value. Carried out of the boot path so the
 * kernel can report the whole environment at once and exit `EX_CONFIG`.
 */
export class ConfigInvalid extends TaggedError("config/ConfigInvalid")<{
  readonly issues: readonly ConfigIssue[];
}> {
  override message = `configuration is invalid`;
}

/** One line per issue, in the order the slices declared them. */
export const describeIssues = (issues: readonly ConfigIssue[]): string =>
  issues.map((issue) => `  ${issue.variable}: ${issue.message}`).join("\n");
