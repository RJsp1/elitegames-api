export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown): AppError {
    return new AppError(message, 400, code, details);
  }

  static unauthorized(message = 'Não autorizado', code = 'UNAUTHORIZED'): AppError {
    return new AppError(message, 401, code);
  }

  static forbidden(message = 'Acesso negado', code = 'FORBIDDEN'): AppError {
    return new AppError(message, 403, code);
  }

  static notFound(message = 'Recurso não encontrado', code = 'NOT_FOUND'): AppError {
    return new AppError(message, 404, code);
  }

  static conflict(message: string, code = 'CONFLICT', details?: unknown): AppError {
    return new AppError(message, 409, code, details);
  }

  static unprocessable(message: string, code = 'UNPROCESSABLE', details?: unknown): AppError {
    return new AppError(message, 422, code, details);
  }

  static tooManyRequests(message = 'Muitas requisições'): AppError {
    return new AppError(message, 429, 'RATE_LIMIT');
  }

  static internal(message = 'Erro interno do servidor', code = 'INTERNAL_ERROR'): AppError {
    return new AppError(message, 500, code);
  }

  static serviceUnavailable(message: string, code = 'SERVICE_UNAVAILABLE'): AppError {
    return new AppError(message, 503, code);
  }
}
