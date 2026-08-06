import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    isAdmin?: boolean;
    registrationAccess?: {
      registrationId: string;
      tokenId: string;
    };
    supabaseUserId?: string | null;
  }
}

export {};
