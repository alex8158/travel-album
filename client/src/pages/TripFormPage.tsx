// Trip create / edit form (P1.T5).
//
// One page, two modes:
//   - mode="create"  — mounted at /trips/new; empty form; POST on submit.
//   - mode="edit"    — mounted at /trips/:id/edit; loads the trip via
//                      GET /api/trips/:id, fills the form, PATCH on submit.
//
// Three lifecycle slots cover the edit case:
//   1. loading the existing trip
//   2. failed to load (e.g. unknown id, network error)
//   3. ready to submit / submitting / submit error
//
// Validation is light client-side (HTML5 `required` + a JS check that
// endDate >= startDate when both are filled) — the backend's zod
// schemas are the single source of truth and any rejection comes back
// as `error.message` in the unified envelope, which we surface inline.
//
// After a successful submit we navigate to "/" (the list page) until
// P1.T6 lands the detail page; that follow-up will switch the target
// to `/trips/${trip.id}`.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createTrip,
  getTripById,
  updateTrip,
  type CreateTripInput,
  type UpdateTripInput,
} from "../api/trips";

export interface TripFormPageProps {
  readonly mode: "create" | "edit";
}

interface FormState {
  title: string;
  description: string;
  destination: string;
  startDate: string;
  endDate: string;
}

const EMPTY_FORM: FormState = {
  title: "",
  description: "",
  destination: "",
  startDate: "",
  endDate: "",
};

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const DESTINATION_MAX = 200;

export default function TripFormPage({ mode }: TripFormPageProps) {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const id = params.id;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(mode === "edit");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    const controller = new AbortController();

    getTripById(id)
      .then((trip) => {
        if (controller.signal.aborted) return;
        setForm({
          title: trip.title,
          description: trip.description ?? "",
          destination: trip.destination ?? "",
          startDate: trip.startDate ?? "",
          endDate: trip.endDate ?? "",
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [mode, id]);

  const trimmedTitle = form.title.trim();
  const datesOutOfOrder = Boolean(form.startDate && form.endDate && form.endDate < form.startDate);
  const formInvalid = trimmedTitle.length === 0 || datesOutOfOrder;

  function update<K extends keyof FormState>(key: K, value: string): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(): CreateTripInput {
    const payload: { -readonly [K in keyof CreateTripInput]: CreateTripInput[K] } = {
      title: trimmedTitle,
    };
    if (form.description) payload.description = form.description;
    if (form.destination) payload.destination = form.destination;
    if (form.startDate) payload.startDate = form.startDate;
    if (form.endDate) payload.endDate = form.endDate;
    return payload;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (formInvalid || submitting) return;
    setSubmitError(null);
    setSubmitting(true);

    try {
      if (mode === "create") {
        await createTrip(buildPayload());
      } else {
        if (!id) throw new Error("Edit mode requires an id in the URL");
        const patch: UpdateTripInput = buildPayload();
        await updateTrip(id, patch);
      }
      navigate("/");
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  // ---- Edit-mode load states ----------------------------------------------

  if (mode === "edit" && loading) {
    return (
      <main>
        <p className="status-text">Loading trip…</p>
      </main>
    );
  }

  if (mode === "edit" && loadError !== null) {
    return (
      <main>
        <header className="page-header">
          <div className="page-header-text">
            <h1>Edit trip</h1>
          </div>
        </header>
        <p className="status-text status-error" role="alert">
          Failed to load trip: {loadError}
        </p>
        <Link to="/" className="btn-secondary">
          Back to trips
        </Link>
      </main>
    );
  }

  // ---- Form ---------------------------------------------------------------

  const heading = mode === "create" ? "New trip" : "Edit trip";
  const submitLabel = mode === "create" ? "Create trip" : "Save changes";
  const submittingLabel = mode === "create" ? "Creating…" : "Saving…";

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <h1>{heading}</h1>
          <p>Fields marked with * are required.</p>
        </div>
        <Link to="/" className="btn-secondary">
          Cancel
        </Link>
      </header>

      <form className="trip-form" onSubmit={onSubmit} noValidate>
        <label className="form-row">
          <span className="form-label">
            Title <span className="form-required">*</span>
          </span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            required
            maxLength={TITLE_MAX}
            autoFocus
          />
        </label>

        <label className="form-row">
          <span className="form-label">Destination</span>
          <input
            type="text"
            value={form.destination}
            onChange={(e) => update("destination", e.target.value)}
            maxLength={DESTINATION_MAX}
          />
        </label>

        <div className="form-row form-row-pair">
          <label className="form-half">
            <span className="form-label">Start date</span>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => update("startDate", e.target.value)}
            />
          </label>
          <label className="form-half">
            <span className="form-label">End date</span>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => update("endDate", e.target.value)}
            />
          </label>
        </div>
        {datesOutOfOrder && (
          <p className="form-error" role="alert">
            End date must be on or after the start date.
          </p>
        )}

        <label className="form-row">
          <span className="form-label">Description</span>
          <textarea
            value={form.description}
            onChange={(e) => update("description", e.target.value)}
            maxLength={DESCRIPTION_MAX}
            rows={4}
          />
        </label>

        {submitError !== null && (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={formInvalid || submitting}>
            {submitting ? submittingLabel : submitLabel}
          </button>
        </div>
      </form>
    </main>
  );
}
