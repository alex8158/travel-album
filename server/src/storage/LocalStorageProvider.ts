// LocalStorageProvider (P0.T7).
//
// Filesystem-backed StorageProvider. Anchored to the configured root,
// which is resolved against the repo root for relative paths so the
// behaviour is independent of the shell's current working directory.
//
// All operations go through pathUtils for validation. The class never
// concatenates user input directly into filesystem paths.

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { alreadyExists, ioError, notFound, StorageError } from "./errors.js";
import { derivedLogicalPath, originalLogicalPath, resolveUnderRoot } from "./pathUtils.js";
import type {
  PutDerivedArgs,
  PutOriginalArgs,
  RemoveResult,
  StorageProvider,
  StoredObject,
} from "./StorageProvider.js";

const here = dirname(fileURLToPath(import.meta.url));
// dev:   <repo>/server/src/storage
// built: <repo>/server/dist/storage
// Both resolve to <repo>/ via "..", "..", "..".
const repoRoot = resolve(here, "..", "..", "..");

function resolveRoot(rawRoot: string): string {
  return isAbsolute(rawRoot) ? rawRoot : resolve(repoRoot, rawRoot);
}

export class LocalStorageProvider implements StorageProvider {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /**
   * Build a provider rooted at the given path. Relative roots are
   * anchored at the repository root. The root directory is created
   * synchronously if it does not exist.
   */
  static create(rawRoot: string): LocalStorageProvider {
    const root = resolveRoot(rawRoot);
    mkdirSync(root, { recursive: true });
    return new LocalStorageProvider(root);
  }

  async putOriginal(args: PutOriginalArgs): Promise<StoredObject> {
    const logicalPath = originalLogicalPath(args.tripId, args.mediaId, args.extension);
    return this.writeFile(logicalPath, args.data, false);
  }

  async putDerived(args: PutDerivedArgs): Promise<StoredObject> {
    const logicalPath = derivedLogicalPath(args.tripId, args.mediaId, args.relPath);
    return this.writeFile(logicalPath, args.data, args.overwrite ?? false);
  }

  async read(logicalPath: string): Promise<Readable> {
    const absolutePath = resolveUnderRoot(this.root, logicalPath);
    try {
      await stat(absolutePath);
    } catch (err) {
      if (isENOENT(err)) throw notFound(logicalPath);
      throw ioError(`stat failed for ${logicalPath}`, err);
    }
    return createReadStream(absolutePath);
  }

  async remove(logicalPath: string): Promise<RemoveResult> {
    const absolutePath = resolveUnderRoot(this.root, logicalPath);
    try {
      await rm(absolutePath, { force: false });
      return { removed: true, logicalPath };
    } catch (err) {
      if (isENOENT(err)) {
        return { removed: false, logicalPath };
      }
      throw ioError(`remove failed for ${logicalPath}`, err);
    }
  }

  async exists(logicalPath: string): Promise<boolean> {
    const absolutePath = resolveUnderRoot(this.root, logicalPath);
    try {
      await stat(absolutePath);
      return true;
    } catch (err) {
      if (isENOENT(err)) return false;
      throw ioError(`stat failed for ${logicalPath}`, err);
    }
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async writeFile(
    logicalPath: string,
    data: Buffer | Readable,
    overwrite: boolean,
  ): Promise<StoredObject> {
    const absolutePath = resolveUnderRoot(this.root, logicalPath);

    if (!overwrite) {
      let existed = false;
      try {
        await stat(absolutePath);
        existed = true;
      } catch (err) {
        if (!isENOENT(err)) {
          throw ioError(`stat failed for ${logicalPath}`, err);
        }
      }
      if (existed) {
        throw alreadyExists(logicalPath);
      }
    }

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
    } catch (err) {
      throw ioError(`mkdir failed for ${dirname(absolutePath)}`, err);
    }

    try {
      const source: Readable = Buffer.isBuffer(data) ? Readable.from(data) : data;
      await pipeline(source, createWriteStream(absolutePath));
    } catch (err) {
      // pipeline already destroys the streams; the file may be partially written.
      // Best-effort cleanup so a future putOriginal does not see a stale half-file.
      try {
        await rm(absolutePath, { force: true });
      } catch {
        /* ignore cleanup errors; the original error is more important */
      }
      if (err instanceof StorageError) throw err;
      throw ioError(`write failed for ${logicalPath}`, err);
    }

    let size: number;
    try {
      size = (await stat(absolutePath)).size;
    } catch (err) {
      throw ioError(`stat after write failed for ${logicalPath}`, err);
    }

    return { logicalPath, absolutePath, size };
  }
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}
