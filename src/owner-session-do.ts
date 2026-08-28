import { DurableObject } from "cloudflare:workers";

export class OwnerSessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)",
      );
      return Promise.resolve();
    });
  }

  record(event: string): void {
    this.ctx.storage.sql.exec("INSERT INTO session_events (event) VALUES (?)", event);
  }
}
