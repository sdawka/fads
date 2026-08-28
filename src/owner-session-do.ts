import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./app-env";

export class OwnerSessionDO extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
      );
      return Promise.resolve();
    });
  }

  record(event: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO session_events (event) VALUES (?)", event);
    return Promise.resolve();
  }
}
