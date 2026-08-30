// `Symbol.for`, not `Symbol()`: two copies of this package would otherwise
// read each other's fragments as untrusted strings and escape them twice.
const HTML: unique symbol = Symbol.for("@btravstack/http-server/html") as never;

/**
 * A rendered HTML fragment — the output of {@link html} or {@link raw}, and
 * nothing else.
 *
 * An object rather than a string, so that what this package escaped is known by
 * the value rather than by a registry, and so a fragment handler returning a
 * bare template literal is a compile error rather than a stored-XSS bug.
 */
export type Html = { readonly [HTML]: true; readonly value: string };

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// One pass over a character class, not five sequential replaces: replacing `&`
// after `<` would turn `&lt;` into `&amp;lt;`.
const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);

const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && HTML in value;

const render = (value: unknown): string => {
  if (isHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(typeof value === "string" ? value : String(value));
};

/**
 * An HTML fragment, with every interpolation escaped.
 *
 * ```ts
 * html`<tr id="order-${order.id}"><td>${order.customerName}</td></tr>`
 * ```
 *
 * A nested `Html` is spliced as it is, and an array of them is concatenated —
 * so a list of rows needs no `join`. Anything else is stringified and escaped.
 */
export const html = (strings: TemplateStringsArray, ...values: readonly unknown[]): Html => ({
  [HTML]: true,
  value: strings.reduce<string>(
    (acc, chunk, index) => acc + (index === 0 ? "" : render(values[index - 1])) + chunk,
    "",
  ),
});

/**
 * Markup admitted whole, unescaped. The only way past {@link html}'s escaping,
 * and a visible act at the call site — which is the point.
 */
export const raw = (markup: string): Html => ({ [HTML]: true, value: markup });
