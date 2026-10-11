import { sharedOry } from "@btravstack/internal-test-infra/ory";

export default async (): Promise<void> => {
  await sharedOry();
};
