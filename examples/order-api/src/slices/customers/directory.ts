import { Port, Provider } from "@btravstack/di";
import type { CustomerView } from "@btravstack/example-order-api-contract";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";

export class CustomerNotFound extends TaggedError("CustomerNotFound")<{ readonly id: string }> {
  override message = `no customer ${this.id}`;
}

export class CustomerDirectory extends Port("CustomerDirectory")<{
  readonly find: (id: string) => AsyncResult<CustomerView, CustomerNotFound>;
}> {}

/** The slice owns its own adapter — which is what makes it liftable into a service of its own. */
export const customerDirectory = Provider(CustomerDirectory)({
  sync: () => {
    const customers = new Map<string, CustomerView>([["c-1", { id: "c-1", name: "Ada" }]]);
    return {
      find: (id) => {
        const found = customers.get(id);
        return found === undefined ? ErrAsync(new CustomerNotFound({ id })) : OkAsync(found);
      },
    };
  },
});
