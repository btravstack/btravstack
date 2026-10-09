/** The scopes options `O` declare, or none — per union member. */
export type ScopesOf<O> = O extends unknown
  ? "scopes" extends keyof O
    ? NonNullable<O["scopes"]> extends readonly string[]
      ? NonNullable<O["scopes"]>
      : readonly []
    : readonly []
  : never;

/**
 * The variable prefix options `O` name, or `Default` where they may name none —
 * per union member, so a prefix the type cannot know stays `string`.
 */
export type PrefixOf<O, Default extends string> = O extends unknown
  ? "variablePrefix" extends keyof O
    ?
        | (NonNullable<O["variablePrefix"]> & string)
        | (Record<never, never> extends Pick<O, "variablePrefix">
            ? Default
            : undefined extends O["variablePrefix"]
              ? Default
              : never)
    : Default
  : never;
