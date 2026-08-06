import type { Request, Response } from 'express';
import {
  createPaymentSchema,
  paymentIdParamSchema,
  refundSchema,
  reissuePaymentSchema,
} from '../schemas/payment.schema.js';
import { paymentService } from '../services/payment/payment.service.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import { AppError } from '../utils/app-error.js';

export class PaymentController {
  async create(req: Request, res: Response): Promise<void> {
    const body = createPaymentSchema.parse(req.body);
    const result = await paymentService.createPayment(body);
    res.status(201).json(result);
  }

  async getById(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await paymentService.getPayment(paymentId);
    res.status(200).json(result);
  }

  async refresh(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await paymentService.refreshPayment(paymentId);
    res.status(200).json(result);
  }

  async reconcile(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await paymentService.reconcilePayment(paymentId);
    res.status(200).json(result);
  }

  async refund(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const body = refundSchema.parse(req.body ?? {});
    const result = await paymentService.refundPayment(paymentId, body.amountCents);
    res.status(200).json(result);
  }

  async reissue(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const body = reissuePaymentSchema.parse(req.body ?? {});
    const payment = await paymentRepository.findPaymentById(paymentId);
    if (!payment) throw AppError.notFound('Pagamento não encontrado');
    if (!payment.registrationId) {
      throw AppError.badRequest('Pagamento sem registration_id', 'MISSING_REGISTRATION');
    }

    const result = await paymentService.reissuePixPayment({
      registrationId: payment.registrationId,
      paymentId: payment.id,
      reason: body.reason,
    });
    res.status(201).json(result);
  }

  async simulatePaid(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await paymentService.simulatePaid(paymentId);
    res.status(200).json(result);
  }
}

export const paymentController = new PaymentController();
