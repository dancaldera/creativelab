/**
 * `AppErrorBoundary` — keeps a render failure from leaving an empty webview.
 *
 * It reports the message and component stack, and offers a reload. Nothing here logs project
 * data: the message is the React error text only, and credentials are never part of a render
 * error because they never enter component state (PRD §13).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Console only: no network, no file write, and the message contains no secrets.
    console.error("Creative Studio renderer error:", error.message);
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h1 style={{ marginTop: 0 }}>Something went wrong in the editor</h1>
        <p>
          The project document is untouched — edits are only committed through the undo stack, and an autosave snapshot is written by the
          native side.
        </p>
        <pre>{error.message}</pre>
        {componentStack ? <pre>{componentStack.trim()}</pre> : null}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload the editor
          </button>
          <button type="button" className="btn" onClick={() => this.setState({ error: null, componentStack: null })}>
            Try to continue
          </button>
        </div>
      </div>
    );
  }
}
