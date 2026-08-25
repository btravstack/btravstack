<template>
  <section class="demo">
    <div class="demo-copy">
      <h2>The container is checked by the compiler</h2>
      <p>
        <code>OrderApplicationModule</code> needs an <code>OrderRepository</code> and a
        <code>Logger</code>. This composition provides neither. Nothing runs — the call does not
        compile, and the error names both missing ports.
      </p>
    </div>
    <div class="demo-panes">
      <pre class="demo-code"><code>Module.scoped(OrderApplicationModule, (ctx) =&gt;
  ctx.get(PlaceOrder).execute(tenant, id, 1),
);</code></pre>
      <pre class="demo-error"><code>src/needs-gate.test-d.ts:61:38 - error TS2345: Argument of type
'Module&lt;ResolvedExports&lt;readonly [typeof PlaceOrder, typeof
FindOrder]&gt;, never, Logger | OrderRepository&gt;'
is not assignable to parameter of type
'Module&lt;…&gt; &amp; { readonly "UNSATISFIED DEPENDENCIES \u2014 nothing
provides": Logger | OrderRepository; }'.

  Property '"UNSATISFIED DEPENDENCIES — nothing provides"' is missing
  in type 'Module&lt;…&gt;' but required in type
  '{ readonly "UNSATISFIED DEPENDENCIES \u2014 nothing provides":
  Logger | OrderRepository; }'.</code></pre>
    </div>
  </section>
</template>

<style scoped>
.demo {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 64px;
}
.demo-copy {
  max-width: 60ch;
  margin-bottom: 24px;
}
.demo-copy h2 {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.demo-copy p {
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
.demo-panes {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr;
}
@media (min-width: 960px) {
  .demo-panes {
    grid-template-columns: 1fr 1fr;
  }
}
.demo-code,
.demo-error {
  margin: 0;
  padding: 20px;
  overflow-x: auto;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
}
.demo-error {
  color: var(--vp-c-danger-1);
  border-color: var(--vp-c-danger-soft);
}
</style>
