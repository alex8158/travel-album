import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <main>
      <h1>404 — Page not found</h1>
      <p>The page you are looking for does not exist or has not been implemented yet.</p>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  );
}
