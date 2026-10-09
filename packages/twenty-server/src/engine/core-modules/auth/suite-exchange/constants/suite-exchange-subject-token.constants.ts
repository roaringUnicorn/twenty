// The body limit is the global settings.storage.maxFileSize, so without this
// ceiling jose base64-decodes and parses a multi-megabyte body before the
// signature check rejects it; a real Clavis EdDSA token is well under 4 KB.
export const SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH = 8192;
