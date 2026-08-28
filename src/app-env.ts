import type { OwnerSessionDO } from "./owner-session-do";

export interface AppEnv extends Omit<Env, "OWNER_SESSION"> {
  OWNER_SESSION: DurableObjectNamespace<OwnerSessionDO>;
}
