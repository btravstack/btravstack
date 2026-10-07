---
title: Send a formatted email
description: "Render a mail's HTML body with an escaping tagged template of your own, in the language the recipient reads, and hand @btravstack/mailer the string it takes."
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import type { Mail } from "@btravstack/mailer";
-->

# Send a formatted email

> **How-to.** Turn an order into a mail body with markup in it, without
> letting a customer's name write HTML into somebody's inbox. For sending it
> and triaging a failed send, see [Send an email](/how-to/send-an-email); for
> the port, [`@btravstack/mailer`](/reference/mailer).

`Mail.html` is a string, deliberately: the mailer takes what you rendered and
has no opinion on how. So the rendering is a function in your application, and
the one thing it must get right is **escaping** — every value interpolated into
the markup is somebody's data, an order id included.

## 1. An escaping template

No dependency. Every interpolated string or number is escaped;
a value that is already markup — another template's result — passes through,
which is what lets one template nest another:

```ts
const trusted: unique symbol = Symbol("markup");

export type Markup = { readonly [trusted]: string };

type Interpolated = string | number | Markup | readonly Markup[];

const escaped = (value: Interpolated): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
    : trusted in value
      ? value[trusted]
      : value.map((item) => item[trusted]).join("");

export const mailHtml = (
  strings: TemplateStringsArray,
  ...values: readonly Interpolated[]
): Markup => ({ [trusted]: String.raw({ raw: strings }, ...values.map(escaped)) });

export const rendered = (markup: Markup): string => markup[trusted];
```

**What passes through unescaped is what only `mailHtml` can mint.** `Markup` is
keyed by a symbol the module never exports, so no value from a database, an
event or a CMS can have its type: `{ markup: "<script>…" }` is refused as an
interpolation by the compiler rather than inserted as it stands. Keep
these lines in a module of their own, exporting `mailHtml`, `rendered` and the
`Markup` type and never `trusted`, and the only way in is through the escaper.

It is **context-blind**, like `@btravstack/http-server`'s own `html`, so its
guarantee covers two places only: **element text**, and the **quoted** value of
an ordinary attribute that is neither a URL nor code — `class`, `title`, `alt`,
`id`. Everything else is out of scope:

- an **unquoted** attribute, where a space ends the value;
- an **executable or nested** attribute — an `on*` handler, `style`, `srcdoc` —
  because the parser decodes the character references this escaper writes
  **before** JavaScript, CSS or the nested document reads the value, so the
  input stays live without ever leaving its quotes;
- a **URL** attribute — `href`, `src` — where `javascript:` needs no escaping
  to run: check the scheme of a caller's link before it reaches the template;
- a `<style>` or `<script>` block.

Keep caller data out of those places rather than escaping it into them. The
helper lives in your application rather than coming from the HTTP server
because a mailer has no business depending on one.

## 2. A render function per mail

The whole mail is one function from the data to the envelope, so `text` and
`html` are written side by side and cannot drift apart. The words come from a
**catalogue** — a typed record per language — so the template holds structure
and the catalogue holds sentences:

```ts
export type Placed = {
  readonly id: string;
  readonly customerName: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number }[];
};

export type Messages = {
  readonly subject: (id: string) => string;
  readonly greeting: (name: string) => string;
  readonly intro: string;
};

export const en: Messages = {
  subject: (id) => `Order ${id} placed`,
  greeting: (name) => `Hello ${name},`,
  intro: "your order is on its way:",
};

export const placedMail = (order: Placed, to: string, messages: Messages): Mail => ({
  from: "orders@example.test",
  to: [to],
  subject: messages.subject(order.id),
  text: [
    messages.greeting(order.customerName),
    messages.intro,
    ...order.lines.map((line) => `- ${line.quantity} × ${line.sku}`),
  ].join("\n"),
  html: rendered(mailHtml`<p>${messages.greeting(order.customerName)}</p>
<p>${messages.intro}</p>
<ul>
  ${order.lines.map((line) => mailHtml`<li>${line.quantity} × ${line.sku}</li>`)}
</ul>`),
});
```

`subject` and `text` are not escaped, and need not be: neither is parsed as
HTML. The message strings are interpolated **into** the template rather than
written as markup, so a translation cannot inject a tag either.

## 3. Another language

A second catalogue is a second value of the same type, so a missing sentence is
a compile error rather than an English fallback in a French mail:

```ts
import { fromThrowable } from "unthrown";

export const fr: Messages = {
  subject: (id) => `Commande ${id} enregistrée`,
  greeting: (name) => `Bonjour ${name},`,
  intro: "votre commande est en route :",
};

const languageOf = fromThrowable(
  (tag: string) => new Intl.Locale(tag).language,
  (cause, defect) => (cause instanceof RangeError ? ("not a language tag" as const) : defect(cause)),
);

export const messagesFor = (locale: string): Messages =>
  languageOf(locale).getOr("en") === "fr" ? fr : en;
```

The tag is parsed rather than prefix-matched, so `FR`, `fr-CA` and `fr-FR` all
read as French — a language subtag is case-insensitive — while `fresh` is a
language of its own rather than a French prefix, and a string that is not a
tag at all, an empty one included, is refused by `Intl.Locale`: both fall back
to English instead of guessing.

Where the locale comes from is your application's: a column on the customer,
a field on the event that triggered the mail, or — under HTTP — a header a
port of your own reads, provided per unit the way the example provides its
`Tenant`. Pluralisation and number formatting are `Intl`'s
(`Intl.PluralRules`, `Intl.NumberFormat`), inside the catalogue's functions.

## 4. Send it

Pass the envelope to `mailer.send` exactly where
[Send an email](/how-to/send-an-email) passes its literal —
`mailer.send(placedMail(order, customer.email, messagesFor(customer.locale)))`
— and triage `MailNotSent` the same way.

**When templates outgrow functions** — a layout shared by every mail,
templates edited by somebody who does not write TypeScript — reach for a
template library that escapes by default, and keep it **inside** the render
function, so `Mail` still receives a string and the mailer still knows
nothing. What a string-template engine costs is the compile-time check: a
renamed field becomes a runtime failure in the one place a user sees.

## Where to go next

- Sending it, and what a failed send means: [Send an email](/how-to/send-an-email).
- The envelope's fields: [`@btravstack/mailer`](/reference/mailer).
- The same escaping rule for a browser:
  [`html` and `raw`](/reference/http-server#html-and-raw).
