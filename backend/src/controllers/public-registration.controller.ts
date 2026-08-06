import type { Request, Response } from 'express';
import {
  createPublicRegistrationSchema,
  publicCategorySlugParamsSchema,
  publicEventSlugParamSchema,
  publicPaymentIdParamSchema,
  publicRegistrationIdParamSchema,
} from '../schemas/public-registration.schema.js';
import { publicRegistrationService } from '../services/public/public-registration.service.js';
import { publicPaymentService } from '../services/public/public-payment.service.js';
import { assertRegistrationTokenMatches } from '../middleware/registration-access.middleware.js';
import { AppError } from '../utils/app-error.js';

export class PublicRegistrationController {
  async getEvent(req: Request, res: Response): Promise<void> {
    const { slug } = publicEventSlugParamSchema.parse(req.params);
    const event = await publicRegistrationService.getPublishedEventBySlug(slug);
    res.status(200).json(event);
  }

  async listCategories(req: Request, res: Response): Promise<void> {
    const { slug } = publicEventSlugParamSchema.parse(req.params);
    const categories = await publicRegistrationService.listCategoriesBySlug(slug);
    res.status(200).json({ categories });
  }

  async getCategory(req: Request, res: Response): Promise<void> {
    const { slug, categorySlug } = publicCategorySlugParamsSchema.parse(req.params);
    const category = await publicRegistrationService.getCategoryBySlugs(slug, categorySlug);
    res.status(200).json(category);
  }

  async createRegistration(req: Request, res: Response): Promise<void> {
    const body = createPublicRegistrationSchema.parse(req.body);
    const xRequestId = req.header('X-Request-Id');
    const idempotencyKey = req.header('Idempotency-Key');
    const headerRequestId =
      (typeof xRequestId === 'string' && xRequestId.trim()) ||
      (typeof idempotencyKey === 'string' && idempotencyKey.trim()) ||
      undefined;
    const requestId = body.requestId ?? (headerRequestId || undefined);
    const result = await publicRegistrationService.createRegistration(body, {
      requestId,
      supabaseUserId: req.supabaseUserId ?? null,
    });
    res.status(201).json(result);
  }

  async createPayment(req: Request, res: Response): Promise<void> {
    const { registrationId } = publicRegistrationIdParamSchema.parse(req.params);
    assertRegistrationTokenMatches(req);
    const requestId =
      typeof req.header('X-Request-Id') === 'string' ? req.header('X-Request-Id')! : undefined;
    const result = await publicPaymentService.createPaymentForRegistration(registrationId, {
      requestId,
    });
    res.status(201).json(result);
  }

  async getPaymentStatus(req: Request, res: Response): Promise<void> {
    const { paymentId } = publicPaymentIdParamSchema.parse(req.params);
    const tokenRegistrationId = req.registrationAccess?.registrationId;
    if (!tokenRegistrationId) {
      throw AppError.unauthorized('Token de inscrição obrigatório');
    }
    const result = await publicPaymentService.getPaymentStatus(paymentId, tokenRegistrationId);
    res.status(200).json(result);
  }

  async reissuePayment(req: Request, res: Response): Promise<void> {
    const { paymentId } = publicPaymentIdParamSchema.parse(req.params);
    const tokenRegistrationId = req.registrationAccess?.registrationId;
    if (!tokenRegistrationId) {
      throw AppError.unauthorized('Token de inscrição obrigatório');
    }
    const requestId =
      typeof req.header('X-Request-Id') === 'string' ? req.header('X-Request-Id')! : undefined;
    const result = await publicPaymentService.reissuePayment(paymentId, tokenRegistrationId, {
      requestId,
    });
    res.status(201).json(result);
  }

  async getReceipt(req: Request, res: Response): Promise<void> {
    const { registrationId } = publicRegistrationIdParamSchema.parse(req.params);
    assertRegistrationTokenMatches(req);
    const result = await publicRegistrationService.getReceipt(registrationId);
    res.status(200).json(result);
  }
}

export const publicRegistrationController = new PublicRegistrationController();
