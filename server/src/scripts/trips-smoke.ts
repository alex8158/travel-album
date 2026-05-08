// Manual smoke test for the Trip domain layer (P1.T2).
//
// Usage: npm run smoke:trips
//
// Builds a private throwaway SQLite DB, runs every migration on it,
// instantiates TripRepository + TripService, and exercises every
// public method plus the rejection paths the user spec requires.
// Exits 1 if any required behaviour fails. Always cleans up.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ValidationError } from "../errors/AppError.js";
import { closeDatabase, openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { StorageError } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function describeError(err: unknown): string {
  if (err instanceof StorageError || err instanceof ValidationError) {
    return `${err.name}(${err.code}, status=${err.statusCode}): ${err.message}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function expectThrows(name: string, fn: () => unknown, expectedCode: string): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  const ok = threw instanceof ValidationError && threw.code === expectedCode;
  record(name, ok, describeError(threw));
}

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "tas-trips-smoke-"));
  const dbPath = path.join(tmpDir, "smoke.db");
  console.log(`[smoke] db path = ${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied",
      migration.appliedNow.includes("001_create_trips.sql"),
      `appliedNow=${JSON.stringify(migration.appliedNow)}`,
    );

    const repo = new TripRepository(dbHandle.db);
    const service = new TripService(repo);

    // 1. createTrip — happy path
    const t1 = service.createTrip({ title: "Tokyo Spring 2026" });
    record(
      "createTrip with title only",
      typeof t1.id === "string" &&
        t1.title === "Tokyo Spring 2026" &&
        t1.deletedAt === null &&
        t1.createdAt === t1.updatedAt,
      `id=${t1.id} createdAt=${t1.createdAt}`,
    );

    // 2. createTrip with all fields
    const t2 = service.createTrip({
      title: "  Spaces trimmed  ",
      description: "Cherry blossoms",
      destination: "Tokyo",
      startDate: "2026-03-15",
      endDate: "2026-03-22",
    });
    record(
      "createTrip trims title and stores all fields",
      t2.title === "Spaces trimmed" &&
        t2.destination === "Tokyo" &&
        t2.startDate === "2026-03-15" &&
        t2.endDate === "2026-03-22",
      `title=${JSON.stringify(t2.title)} destination=${t2.destination} dates=${t2.startDate}/${t2.endDate}`,
    );

    // 3. listTrips — both visible
    const list1 = service.listTrips();
    record(
      "listTrips returns both active rows ordered by created_at DESC",
      list1.length === 2 &&
        list1.every((t) => t.deletedAt === null) &&
        list1[0]!.createdAt >= list1[1]!.createdAt,
      `ids=${list1.map((t) => t.id).join(",")}`,
    );

    // 4. getTripById — found
    const fetched = service.getTripById(t1.id);
    record(
      "getTripById returns the right row",
      fetched.id === t1.id && fetched.title === t1.title,
      `id=${fetched.id}`,
    );

    // 5. getTripById — unknown id throws NotFoundError
    {
      let threw: unknown;
      try {
        service.getTripById("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      } catch (err) {
        threw = err;
      }
      const ok =
        threw instanceof Error &&
        "code" in threw &&
        (threw as { code: unknown }).code === "NOT_FOUND";
      record("getTripById unknown id throws NOT_FOUND", ok, describeError(threw));
    }

    // 6. updateTrip — refreshes updated_at and writes new fields
    // Wait briefly so toISOString() differs from create time.
    await sleep(20);
    const t1b = service.updateTrip(t1.id, {
      title: "Tokyo Spring 2026 (revised)",
      description: "Updated copy",
      destination: "Tokyo, Japan",
      startDate: "2026-03-10",
      endDate: "2026-03-20",
    });
    record(
      "updateTrip refreshes updated_at and patches fields",
      t1b.title === "Tokyo Spring 2026 (revised)" &&
        t1b.destination === "Tokyo, Japan" &&
        t1b.startDate === "2026-03-10" &&
        t1b.endDate === "2026-03-20" &&
        t1b.updatedAt > t1.updatedAt &&
        t1b.createdAt === t1.createdAt,
      `updatedAt: ${t1.updatedAt} -> ${t1b.updatedAt}`,
    );

    // 7. softDeleteTrip — removes from default list and getById
    service.softDeleteTrip(t1.id);
    const list2 = service.listTrips();
    record(
      "softDelete hides trip from default list",
      list2.length === 1 && list2[0]!.id === t2.id,
      `remaining ids=${list2.map((t) => t.id).join(",")}`,
    );

    {
      let threw: unknown;
      try {
        service.getTripById(t1.id);
      } catch (err) {
        threw = err;
      }
      const ok =
        threw instanceof Error &&
        "code" in threw &&
        (threw as { code: unknown }).code === "NOT_FOUND";
      record("getTripById on soft-deleted trip throws NOT_FOUND", ok, describeError(threw));
    }

    // 8. listTrips({includeDeleted:true}) reveals the soft-deleted row
    const list3 = service.listTrips({ includeDeleted: true });
    record(
      "listTrips({includeDeleted:true}) includes the soft-deleted row",
      list3.length === 2 && list3.some((t) => t.id === t1.id && t.deletedAt !== null),
      `ids+deletedAt=${list3.map((t) => `${t.id}:${t.deletedAt ?? "live"}`).join(", ")}`,
    );

    // 9. softDelete on already-deleted id throws NOT_FOUND
    {
      let threw: unknown;
      try {
        service.softDeleteTrip(t1.id);
      } catch (err) {
        threw = err;
      }
      const ok =
        threw instanceof Error &&
        "code" in threw &&
        (threw as { code: unknown }).code === "NOT_FOUND";
      record("softDelete on already-deleted id throws NOT_FOUND", ok, describeError(threw));
    }

    // ---- Negative cases (zod) ----

    expectThrows(
      "create rejects empty title",
      () => service.createTrip({ title: "" }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "create rejects whitespace-only title",
      () => service.createTrip({ title: "   " }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "create rejects malformed start_date",
      () => service.createTrip({ title: "X", startDate: "2026/03/15" }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "create rejects impossible calendar date",
      () => service.createTrip({ title: "X", startDate: "2024-02-30" }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "create rejects end_date < start_date",
      () =>
        service.createTrip({
          title: "X",
          startDate: "2024-12-31",
          endDate: "2024-01-01",
        }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "getTripById rejects malformed id",
      () => service.getTripById("not a uuid; with spaces"),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "createTrip rejects unknown extra field (strict)",
      () => service.createTrip({ title: "X", malicious: "payload" }),
      "VALIDATION_FAILED",
    );

    expectThrows(
      "updateTrip rejects empty title",
      () => service.updateTrip(t2.id, { title: "" }),
      "VALIDATION_FAILED",
    );

    // 10. Update with only end_date that flips DB constraint (DB CHECK
    // catches it; Service translates to VALIDATION_FAILED).
    {
      let threw: unknown;
      try {
        service.updateTrip(t2.id, { endDate: "2020-01-01" });
      } catch (err) {
        threw = err;
      }
      const ok = threw instanceof ValidationError && threw.code === "VALIDATION_FAILED";
      record(
        "partial update that flips date order maps DB CHECK to VALIDATION_FAILED",
        ok,
        describeError(threw),
      );
    }

    // 11. coverMediaId format is enforced
    expectThrows(
      "create rejects malformed coverMediaId",
      () => service.createTrip({ title: "X", coverMediaId: "../../etc/passwd" }),
      "VALIDATION_FAILED",
    );

    // 12. Final state check
    const finalList = service.listTrips();
    record(
      "final default list size is 1 (only t2 remains)",
      finalList.length === 1 && finalList[0]!.id === t2.id,
      `count=${finalList.length}`,
    );
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpDir, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpDir}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dumpUnexpected(err: unknown): never {
  console.error("[smoke] unexpected error:", err);
  process.exit(1);
}

void main().catch(dumpUnexpected);
