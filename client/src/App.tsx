import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import NotFoundPage from "./pages/NotFoundPage";

// Route shell only. Business routes (per docs/design.md §2.2) will be added
// in their corresponding tasks:
//
//   /trips/new                  -> P1.T5 (TripCreatePage)
//   /trips/:id/edit             -> P1.T5 (TripEditPage)
//   /trips/:id                  -> P1.T6 / P2.T7 (Gallery)
//   /trips/:id/upload           -> P2.T6 (UploadPage)
//   /trips/:id/duplicates       -> P5.T6 (DuplicateGroupListPage)
//   /duplicate-groups/:id       -> P5.T6 (DuplicateGroupDetailPage)
//   /media/:id                  -> P3.T4 / P6 / P8 / P10 (MediaDetailPage)
//   /videos/:id/segments        -> P9.T9 (VideoSegmentsPage)
//   /jobs                       -> P4.T6 (JobsPage)
//
// Until then, only "/" and the 404 fallback are wired up.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
