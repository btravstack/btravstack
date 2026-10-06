import { Provider } from "@btravstack/di";

import { Observers, noObserver } from "./observation.js";

/**
 * The no-op member every module reading {@link Observers} provides, so the set
 * it reads is never the empty dependency di refuses: a graph composing no
 * observability still starts. One provider, shared — di de-duplicates a graph's
 * providers by reference, so however many modules contribute it, an operation
 * costs one inert call.
 */
export const noObserverMember = Provider.member(Observers)({ inject: {}, value: noObserver });
