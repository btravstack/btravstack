import { describe, expect, it } from "vitest";

import { html, raw } from "./html.js";

describe("html", () => {
  it("escapes every character that could close a tag or an attribute", () => {
    // GIVEN a value carrying each character HTML gives meaning to
    const hostile = `<script>&"'`;

    // WHEN it is interpolated
    const rendered = html`<p title="${hostile}">${hostile}</p>`;

    // THEN every one is escaped, in both element and attribute position
    expect(rendered.value).toBe(
      `<p title="&lt;script&gt;&amp;&quot;&#39;">&lt;script&gt;&amp;&quot;&#39;</p>`,
    );
  });

  it("splices a nested Html once rather than escaping it again", () => {
    // GIVEN a fragment built by html``, interpolated into another
    const row = html`<td>${"a & b"}</td>`;

    // WHEN it is nested
    const rendered = html`<tr>${row}</tr>`;

    // THEN the inner escaping stands and was not applied twice — composition is
    // what a fragment answerer does all day
    expect(rendered.value).toBe(`<tr><td>a &amp; b</td></tr>`);
  });

  it("renders each value of an array, so a list needs no join", () => {
    // GIVEN a list of fragments
    const rows = ["a", "b"].map((cell) => html`<td>${cell}</td>`);

    // WHEN the array is interpolated
    const rendered = html`<tr>${rows}</tr>`;

    // THEN they are concatenated with no separator and no comma
    expect(rendered.value).toBe(`<tr><td>a</td><td>b</td></tr>`);
  });

  it("admits markup whole through raw, which is the only way in", () => {
    // GIVEN markup a caller has decided is trusted
    const trusted = raw("<br>");

    // WHEN it is interpolated
    const rendered = html`<p>${trusted}</p>`;

    // THEN it survives unescaped
    expect(rendered.value).toBe("<p><br></p>");
  });
});
