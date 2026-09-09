import type { OwnerSessionDO } from "./owner-session-do";
import type { RuntimeEnvironment } from "./runtime-config";

export interface AppEnv extends Omit<Env, "OWNER_SESSION">, RuntimeEnvironment {
  OWNER_SESSION: DurableObjectNamespace<OwnerSessionDO>;
}
