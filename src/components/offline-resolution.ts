import type { OutboxStore } from "../modules/offline";

export async function resetFailedChangesForRetry(store: OutboxStore): Promise<number> {
  const failed = (await store.list()).filter((entry) => entry.state === "failed");
  for (const entry of failed) {
    await store.remove(entry.id);
    await store.put({ ...entry, state: "pending", lastError: undefined });
  }
  return failed.length;
}

export async function discardFailedChanges(store: OutboxStore): Promise<number> {
  const failed = (await store.list()).filter((entry) => entry.state === "failed");
  for (const entry of failed) await store.remove(entry.id);
  return failed.length;
}
