// The bucket is keyed on req.ip and the throttle runs before the service, so
// the session-reuse path every reload takes is counted too and a whole office
// behind one NAT shares this budget. It only has to bound JWT signature
// verification, which is cheap, so it is set well above ordinary team use.
export const SUITE_EXCHANGE_RATE_LIMIT_MAX = 300;

export const SUITE_EXCHANGE_RATE_LIMIT_WINDOW_MS = 60_000;
