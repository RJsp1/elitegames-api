import type { PaymentEventRecord } from './payment.types.js';
import type { SicrediPixItem } from './sicredi.types.js';

export interface WebhookProcessResult {
  received: number;
  processed: number;
  duplicated: number;
  ignored: number;
  errors: Array<{ endToEndId?: string; txid?: string; message: string }>;
}

export type { PaymentEventRecord, SicrediPixItem };
