import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  adminActionBodySchema,
  adminAuditQuerySchema,
  adminMetricsQuerySchema,
  adminPaymentIdParamSchema,
  adminPaymentListQuerySchema,
} from '../schemas/admin-payment.schema.js';
import { adminPaymentDashboardService } from '../services/admin/admin-payment-dashboard.service.js';
import { adminPaymentActionsService } from '../services/admin/admin-payment-actions.service.js';
import { paymentEventRepository } from '../repositories/payment-event.repository.js';
import { AppError } from '../utils/app-error.js';
import { webhookController } from './webhook.controller.js';

export class AdminPaymentController {
  async dashboard(_req: Request, res: Response): Promise<void> {
    const result = await adminPaymentDashboardService.getDashboard();
    res.status(200).json(result);
  }

  async listPayments(req: Request, res: Response): Promise<void> {
    // Compat: ?limit= ainda funciona via pageSize
    const raw = { ...req.query };
    if (raw.limit && !raw.pageSize) {
      raw.pageSize = raw.limit;
    }
    const query = adminPaymentListQuerySchema.parse(raw);
    const result = await adminPaymentDashboardService.listPayments(query);
    res.status(200).json({
      payments: result.items,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  }

  async metrics(req: Request, res: Response): Promise<void> {
    const query = adminMetricsQuerySchema.parse(req.query);
    const result = await adminPaymentDashboardService.getMetrics(query);
    res.status(200).json(result);
  }

  async getPayment(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const result = await adminPaymentDashboardService.getPaymentDetail(paymentId);
    res.status(200).json(result);
  }

  async listAudit(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const query = adminAuditQuerySchema.parse(req.query);
    const result = await adminPaymentDashboardService.listAudit(paymentId, query);
    res.status(200).json(result);
  }

  async reissue(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const body = adminActionBodySchema.parse(req.body ?? {});
    const result = await adminPaymentActionsService.reissue(paymentId, body.reason);
    res.status(201).json(result);
  }

  async reconcile(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const result = await adminPaymentActionsService.reconcile(paymentId);
    res.status(200).json(result);
  }

  async expire(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const body = adminActionBodySchema.parse(req.body ?? {});
    if (body.confirm !== true) {
      throw AppError.badRequest('Confirme a expiração com confirm=true', 'CONFIRM_REQUIRED');
    }
    const result = await adminPaymentActionsService.expire(paymentId, body.reason);
    res.status(200).json(result);
  }

  async cancel(req: Request, res: Response): Promise<void> {
    const { paymentId } = adminPaymentIdParamSchema.parse(req.params);
    const body = adminActionBodySchema.parse(req.body ?? {});
    if (body.confirm !== true) {
      throw AppError.badRequest('Confirme o cancelamento com confirm=true', 'CONFIRM_REQUIRED');
    }
    const result = await adminPaymentActionsService.cancel(paymentId, body.reason);
    res.status(200).json(result);
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
