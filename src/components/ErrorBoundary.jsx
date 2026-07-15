import { Component } from 'react'

// Minimal error boundary. Wrap a risky subtree so a throw inside it degrades to
// a fallback instead of crashing the whole page. Used first by Inventory's
// arrange mode (the drag code in Stage 2b is the risky part) — the TDZ crash
// lesson: isolate risky UI so it can't take down counting.
//
// `fallback` may be a ReactNode, or a function (error, reset) => ReactNode so
// the caller can offer a "recover" action that also resets the boundary.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Best-effort logging; never rethrow (would defeat the boundary). Also keep the
    // React component stack so a fallback can surface WHERE it threw (on screen).
    console.error('ErrorBoundary caught:', error, info)
    this.setState({ info })
  }

  reset = () => this.setState({ error: null, info: null })

  render() {
    if (this.state.error) {
      const { fallback } = this.props
      if (typeof fallback === 'function') return fallback(this.state.error, this.reset, this.state.info)
      if (fallback != null) return fallback
      return (
        <div style={{ padding: 16, color: '#b91c1c', fontSize: 13 }}>
          Something went wrong in this panel.
        </div>
      )
    }
    return this.props.children
  }
}
