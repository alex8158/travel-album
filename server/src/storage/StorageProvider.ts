// StorageProvider interface (P0.T7).
//
// Concrete implementations in this file's siblings:
//   - LocalStorageProvider  (filesystem; the only first-version backend)
//   - S3StorageProvider     (later phase; not in scope here)
//
// Logical paths are forward-slash, relative to the provider's root, and
// always validated by storage/pathUtils.ts before they reach the
// filesystem. See docs/design.md §5 for the directory layout.

import type { Readable } from "node:stream";

export interface StoredObject {
  /** Canonical logical path under the storage root, forward-slash, normalised. */
  readonly logicalPath: string;
  /** Absolute path on the underlying backend (only useful for local debugging). */
  readonly absolutePath: string;
  /** File size in bytes after the write completes. */
  readonly size: number;
}

export interface PutOriginalArgs {
  readonly tripId: string;
  readonly mediaId: string;
  /** Extension WITHOUT leading dot, e.g. "jpg". Limited to /^[A-Za-z0-9]{1,8}$/. */
  readonly extension: string;
  /** Source content. Buffer is consumed in one shot; Readable is piped. */
  readonly data: Buffer | Readable;
}

export interface PutDerivedArgs {
  readonly tripId: string;
  readonly mediaId: string;
  /**
   * Path WITHIN derived/{mediaId}/, forward-slash, no leading slash, no "..".
   * Examples: "thumb.webp", "frames/00001.jpg", "segments/seg-12.mp4".
   */
  readonly relPath: string;
  readonly data: Buffer | Readable;
  /**
   * Default false. Pass true when re-running enhancement / AI refine and
   * the existing derived file should be replaced. Original files are
   * never overwriteable — that's `putOriginal`'s problem domain.
   */
  readonly overwrite?: boolean;
}

export interface RemoveResult {
  /** Whether a file was actually deleted. False = nothing existed. */
  readonly removed: boolean;
  /** The logical path that was targeted, echoed back for log/audit purposes. */
  readonly logicalPath: string;
}

export interface StorageProvider {
  /** Absolute path of the storage root, exposed for diagnostics / logging. */
  readonly root: string;

  /**
   * Place the original file at trips/{tripId}/originals/{mediaId}.{ext}.
   * Refuses overwrite — originals are immutable per CLAUDE.md §2.1.
   * Throws StorageError(STORAGE_ALREADY_EXISTS) if the file already exists.
   */
  putOriginal(args: PutOriginalArgs): Promise<StoredObject>;

  /**
   * Place a derived file at trips/{tripId}/derived/{mediaId}/{relPath}.
   * `overwrite` defaults to false; an existing file with the same path
   * triggers STORAGE_ALREADY_EXISTS unless overwrite=true was passed.
   */
  putDerived(args: PutDerivedArgs): Promise<StoredObject>;

  /**
   * Open a readable stream for the file at `logicalPath`. The promise
   * rejects with STORAGE_NOT_FOUND when no file exists; subsequent
   * stream errors (e.g. mid-read disk failures) surface on the stream
   * itself and are the caller's responsibility.
   */
  read(logicalPath: string): Promise<Readable>;

  /**
   * Delete the file at `logicalPath`. Missing files do NOT throw — the
   * result's `removed` flag distinguishes "deleted now" from "wasn't
   * there to begin with". Permission / IO failures still throw.
   */
  remove(logicalPath: string): Promise<RemoveResult>;

  /**
   * Whether a file exists at `logicalPath`. Permission / IO failures
   * still throw; only "missing" returns false silently.
   */
  exists(logicalPath: string): Promise<boolean>;
}
