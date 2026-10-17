// A re-export, not `const GraphqlModule = AnswererModule`: the alias would emit
// the whole generic signature into this package's declarations.
export { AnswererModule as GraphqlModule } from "@btravstack/http-server/internal";
