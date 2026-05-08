// Public surface for the trips domain (P1.T2).
//
// Importers should pull from "../trips" rather than reaching into
// individual files. Internal types (TripRow) and the bare zod
// schemas live in their respective modules and are not re-exported.

export type { ListTripsOptions, Trip, TripCreateData, TripUpdateData } from "./tripTypes.js";

export { TripRepository } from "./tripRepository.js";
export { TripService } from "./tripService.js";

export {
  createTripSchema,
  entityIdSchema,
  isoDateSchema,
  listTripsOptionsSchema,
  updateTripSchema,
  type CreateTripInput,
  type ListTripsInput,
  type UpdateTripInput,
} from "./tripSchemas.js";
