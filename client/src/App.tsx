import { BrowserRouter, Routes, Route } from "react-router-dom";
import DuplicateGroupDetailPage from "./pages/DuplicateGroupDetailPage";
import DuplicateGroupListPage from "./pages/DuplicateGroupListPage";
import JobsPage from "./pages/JobsPage";
import MediaDetailPage from "./pages/MediaDetailPage";
import NotFoundPage from "./pages/NotFoundPage";
import TripDetailPage from "./pages/TripDetailPage";
import TripFormPage from "./pages/TripFormPage";
import TripListPage from "./pages/TripListPage";
import TripRecycleBinPage from "./pages/TripRecycleBinPage";
import UploadPage from "./pages/UploadPage";
import VideoSegmentsPage from "./pages/VideoSegmentsPage";

// Route shell. Business routes (per docs/design.md §2.2) land in their
// corresponding tasks:
//
//   /                           -> P1.T4 (TripListPage)            ✓ wired
//   /trips/new                  -> P1.T5 (TripFormPage create)     ✓ wired
//   /trips/:id/edit             -> P1.T5 (TripFormPage edit)       ✓ wired
//   /trips/:id                  -> P1.T6 (TripDetailPage skeleton) ✓ wired
//                                  P2.T7 filled the gallery section
//   /trips/:id/upload           -> P2.T6 (UploadPage)              ✓ wired
//   /trips/:id/recycle-bin      -> P7.T4 (TripRecycleBinPage)       ✓ wired
//   /trips/:id/duplicates       -> P5.T6 (DuplicateGroupListPage)   ✓ wired
//   /duplicate-groups/:id       -> P5.T6 (DuplicateGroupDetailPage) ✓ wired
//   /media/:id                  -> P3.T6 (MediaDetailPage v1)      ✓ wired
//                                  P6 / P8 / P10 add features
//   /videos/:mediaId/segments   -> P9.T9 (VideoSegmentsPage)        ✓ wired
//   /jobs                       -> P4.T6 (JobsPage)             ✓ wired
//
// Route order matters: /trips/new sits before /trips/:id so it does
// not get swallowed by the parameter route. The /trips/:id/upload and
// /trips/:id/edit routes are also more specific than /trips/:id and
// therefore listed first.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TripListPage />} />
        <Route path="/trips/new" element={<TripFormPage mode="create" />} />
        <Route path="/trips/:id/edit" element={<TripFormPage mode="edit" />} />
        <Route path="/trips/:id/upload" element={<UploadPage />} />
        <Route path="/trips/:id/recycle-bin" element={<TripRecycleBinPage />} />
        <Route path="/trips/:tripId/duplicates" element={<DuplicateGroupListPage />} />
        <Route path="/trips/:id" element={<TripDetailPage />} />
        <Route path="/duplicate-groups/:id" element={<DuplicateGroupDetailPage />} />
        <Route path="/media/:id" element={<MediaDetailPage />} />
        <Route path="/videos/:mediaId/segments" element={<VideoSegmentsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
