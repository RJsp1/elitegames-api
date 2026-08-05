import type { Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/payment/payment.service.js';
import { paymentEventRepository } from '../repositories/payment-event.repository.js';
import { AppError } from '../utils/app-error.js';
import { webhookController } from './webhook.controller.js';

export class AdminPaymentController {
  async listPayments(req: Request, res: Response): Promise<void> {
    const limit = z.coerce.number().int().min(1).max(200).optional().default(50).parse(req.query.limit);
    const payments = await paymentService.listPayments(limit);
    res.status(200).json({ payments });
  }

  async listEvents(req: Request, res: Response): Promise<void> {
    const limit = z.coerce.number().int().min(1).max(200).optional().default(50).parse(req.query.limit);
    const events = await paymentEventRepository.list(limit);
    res.status(200).json({ events });
  }

  async reprocessEvent(req: Request, res: Response): Promise<void> {
    const id = z.string().min(1).parse(req.params.id);
    const event = await paymentEventRepository.findById(id);
    if (!event) throw AppError.notFound('Evento não encontrado');

    const payload = event.payload as {
      endToEndId?: string;
      txid?: string;
      valor?: string;
      horario?: string;
    };
    if (!payload?.endToEndId || !payload.valor || !payload.horario) {
      throw AppError.badRequest('Payload do evento incompleto para reprocessamento');
    }

    const fakeReq = {
      ...req,
      body: { pix: [payload] },
      requestId: req.requestId,
    } as Request;

    let captured: unknown;
    const fakeRes = {
      status(_code: number) {
        return this;
      },
      json(body: unknown) {
        captured = body;
        return this;
      },
    } as unknown as Response;

    await webhookController.handleSicrediPix(fakeReq, fakeRes);
    await paymentEventRepository.markProcessed(id);

    res.status(200).json({ reprocessed: true, result: captured });
  }
}

export const adminPaymentController = new AdminPaymentController();
