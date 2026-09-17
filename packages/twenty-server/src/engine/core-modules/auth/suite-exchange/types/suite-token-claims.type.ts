// The claims of a suite (Clavis) access token this module relies on. Clavis
// also issues `role`, which a deployment serving one workspace ignores.
export type SuiteTokenClaims = {
  subject: string;
  email: string;
  issuer: string;
  organizationId?: string;
};
