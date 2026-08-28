import { QueueMessageSchema, type QueueMessage } from "./contracts";

export function handleQueue(batch: MessageBatch<QueueMessage>): void {
  const messages = batch.messages.map((message) => QueueMessageSchema.safeParse(message.body));
  if (messages.some((message) => !message.success)) {
    batch.retryAll();
    return;
  }

  console.info(
    JSON.stringify({
      event: "ingestion_queue_received",
      messageKinds: messages.map((message) => (message.data as QueueMessage).kind),
    }),
  );
  batch.ackAll();
}

export function handleScheduled(controller: ScheduledController): void {
  console.info(JSON.stringify({ event: "scheduled_tick", cron: controller.cron }));
  controller.noRetry();
}
