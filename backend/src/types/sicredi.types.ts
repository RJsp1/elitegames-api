export interface SicrediTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface SicrediCachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  scope?: string;
}

export interface SicrediCobDevedor {
  cpf?: string;
  cnpj?: string;
  nome: string;
}

export interface SicrediCobRequest {
  calendario: {
    expiracao: number;
  };
  devedor?: SicrediCobDevedor;
  valor: {
    original: string;
  };
  chave: string;
  solicitacaoPagador?: string;
  infoAdicionais?: Array<{ nome: string; valor: string }>;
}

export interface SicrediCobResponse {
  txid: string;
  status: string;
  calendario: {
    criacao: string;
    expiracao: number;
  };
  loc?: {
    id: number;
    location: string;
    tipoCob: string;
  };
  location?: string;
  pixCopiaECola?: string;
  revisao?: number;
  devedor?: SicrediCobDevedor;
  valor: {
    original: string;
  };
  chave: string;
  solicitacaoPagador?: string;
  infoAdicionais?: Array<{ nome: string; valor: string }>;
}

export interface SicrediPixItem {
  endToEndId: string;
  txid?: string;
  valor: string;
  horario: string;
  infoPagador?: string;
  chave?: string;
}

export interface SicrediWebhookPayload {
  pix: SicrediPixItem[];
}

export interface SicrediRefundRequest {
  valor: string;
}

export interface SicrediRefundResponse {
  id: string;
  rtrId?: string;
  valor: string;
  horario?: { solicitacao?: string; liquidacao?: string };
  status: string;
}
