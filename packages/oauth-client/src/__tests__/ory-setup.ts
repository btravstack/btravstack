import { sharedKeycloak } from "@btravstack/internal-test-infra/keycloak";
import { sharedOry } from "@btravstack/internal-test-infra/ory";

export default async (): Promise<void> => {
  await Promise.all([sharedOry(), sharedKeycloak()]);
};
