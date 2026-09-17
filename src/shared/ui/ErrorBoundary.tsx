import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { name: string; children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[${this.props.name}]`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-text-muted">
        <div>
          <div className="mb-2 text-text-hi">The {this.props.name} crashed.</div>
          <div className="mb-3 font-mono text-xs">{this.state.error.message}</div>
          <button type="button" className="rounded-lg border border-border px-3 py-1 hover:bg-muted" onClick={() => this.setState({ error: null })}>Reload view</button>
        </div>
      </div>
    );
  }
}
