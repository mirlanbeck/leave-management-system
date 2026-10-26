import type { Prisma } from '../generated/prisma/client';
import type { MailType } from '../generated/prisma/enums';

export interface OutboxDraft {
  type: MailType;
  vacationId: number;
  recipientId: number;
  subject: string;
  body: string;
}

/**
 * Ставит письма в очередь внутри транзакции операции (architecture §4, §6 п.4): одним запросом,
 * по возрастанию recipientId, ON CONFLICT DO NOTHING по ключу «тип + отпуск + получатель»
 * (RULES §8-3). `createdAt` - момент по Clock (RULES §9-1); отправляет диспетчер (S4-b).
 */
export async function enqueueMail(
  tx: Pick<Prisma.TransactionClient, 'outboxMessage'>,
  drafts: readonly OutboxDraft[],
  createdAt: Date,
): Promise<void> {
  const data = [...drafts]
    .sort((a, b) => a.recipientId - b.recipientId)
    .map((d) => ({ ...d, createdAt }));
  await tx.outboxMessage.createMany({ data, skipDuplicates: true });
}
