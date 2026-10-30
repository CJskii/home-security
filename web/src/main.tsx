import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./lib/api";
import { AuthGate, EventsPage, CamerasPage, SettingsPage } from "./app";
import "./index.css";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      gcTime: 300000,
      retry: (attempt, error) =>
        !(error instanceof ApiError && error.status === 401) && attempt < 1,
      refetchOnWindowFocus: false,
    },
  },
});
class Boundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="p-10">
        <h1>Unable to display the dashboard</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Reload the page to reconnect. Check that the backend API matches this
          release.
        </p>
        <button
          className="mt-4 underline"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boundary>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <Routes>
            <Route element={<AuthGate />}>
              <Route index element={<EventsPage overview />} />
              <Route path="explore" element={<EventsPage />} />
              <Route path="cameras" element={<CamerasPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </Boundary>
  </React.StrictMode>,
);
