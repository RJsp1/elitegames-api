import type { Request, Response } from 'express';
import { createPaymentSchema, paymentIdParamSchema, refundSchema } from '../schemas/payment.schema.js';
import { paymentService } from '../services/payment/payment.service.js';

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

  async simulatePaid(req: Request, res: Response): Promise<void> {
    const { paymentId } = paymentIdParamSchema.parse(req.params);
    const result = await paymentService.simulatePaid(paymentId);
    res.status(200).json(result);
  }
}

export const paymentController = new PaymentController();
