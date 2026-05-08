// Storage-layer errors (P0.T7).
//
// `StorageError` extends `AppError` so route handlers can rethrow it
// untouched and the global error middleware will produce the unified
// JSON response with the right HTTP status. Worker / non-HTTP code can
// also catch by class without caring about HTTP semantics.

import { AppError, type AppErrorOptions } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";

export type StorageErrorCode =
  | typeof ERROR_CODES.STORAGE_INVALID_KEY
  | typeof ERROR_CODES.STORAGE_PATH_TRAVERSAL
  | typeof ERROR_CODES.STORAGE_ALREADY_EXISTS
  | typeof ERROR_CODES.STORAGE_NOT_FOUND
  | typeof ERROR_CODES.STORAGE_IO_ERROR;

export class StorageError extends AppError {
  override readonly name = "StorageError";

  constructor(code: StorageErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(code, message, opts);
  }
}

export function invalidKey(reason: string): StorageError {
  return new StorageError(ERROR_CODES.STORAGE_INVALID_KEY, `Invalid storage key: ${reason}`, {
    statusCode: 400,
  });
}

export function pathTraversal(reason: string): StorageError {
  return new StorageError(ERROR_CODES.STORAGE_PATH_TRAVERSAL, `Path traversal blocked: ${reason}`, {
    statusCode: 400,
  });
}

export function alreadyExists(logicalPath: string): StorageError {
  return new StorageError(
    ERROR_CODES.STORAGE_ALREADY_EXISTS,
    `Storage object already exists: ${logicalPath}`,
    { statusCode: 409, details: { logicalPath } },
  );
}

export function notFound(logicalPath: string): StorageError {
  return new StorageError(
    ERROR_CODES.STORAGE_NOT_FOUND,
    `Storage object not found: ${logicalPath}`,
    { statusCode: 404, details: { logicalPath } },
  );
}

export function ioError(message: string, cause: unknown): StorageError {
  return new StorageError(ERROR_CODES.STORAGE_IO_ERROR, `Storage IO error: ${message}`, {
    statusCode: 500,
    cause,
  });
}

export function isStorageError(err: unknown): err is StorageError {
  return err instanceof StorageError;
}
