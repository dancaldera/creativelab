/**
 * Renderer entry point.
 *
 * Order matters: theme and layout CSS are imported before the component tree so the first
 * paint is already styled, and the error boundary wraps everything so a render failure shows
 * a recoverable message instead of a blank webview.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./styles/theme.css";
import "./styles/shell.css";
import "./styles/panels.css";
import "./styles/preview.css";
import "./styles/timeline.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The bridge is local IPC, so failures are real problems rather than flaky networks:
      // retry once, then surface the error to the panel that asked.
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Renderer bootstrap failed: #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
