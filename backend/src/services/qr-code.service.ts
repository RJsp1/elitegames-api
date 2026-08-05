import QRCode from 'qrcode';
import { AppError } from '../utils/app-error.js';

export class QrCodeService {
  async toDataUrl(pixCopiaECola: string): Promise<string> {
    if (!pixCopiaECola || pixCopiaECola.trim().length < 10) {
      throw AppError.badRequest('pixCopiaECola inválido para gerar QR Code');
    }

    return QRCode.toDataURL(pixCopiaECola, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      width: 320,
    });
  }
}

export const qrCodeService = new QrCodeService();
