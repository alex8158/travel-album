// Public surface for the storage layer (P0.T7). Importers should pull
// from "../storage" rather than reaching into individual files.

export type {
  PutDerivedArgs,
  PutOriginalArgs,
  RemoveResult,
  StorageProvider,
  StoredObject,
} from "./StorageProvider.js";

export { LocalStorageProvider, type PutAudioLibraryFileArgs } from "./LocalStorageProvider.js";

export {
  StorageError,
  alreadyExists,
  invalidKey,
  ioError,
  isStorageError,
  notFound,
  pathTraversal,
  type StorageErrorCode,
} from "./errors.js";

export {
  assertSafeRelPath,
  assertValidExtension,
  assertValidId,
  audioLibraryLogicalPath,
  derivedLogicalPath,
  originalLogicalPath,
  resolveUnderRoot,
  type AudioLibrarySubdir,
} from "./pathUtils.js";
