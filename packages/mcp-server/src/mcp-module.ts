// A re-export, not `const McpModule = AnswererModule`: the alias would emit
// the whole generic signature into this package's declarations.
export { AnswererModule as McpModule } from "@btravstack/http-server/internal";
