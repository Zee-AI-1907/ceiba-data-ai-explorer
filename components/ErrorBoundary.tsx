'use client'

import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

/**
 * ErrorBoundary — wraps the app and catches unhandled render errors.
 * Displays a dark-theme error card consistent with the Ceiba Data design system.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console; can be wired to a monitoring service later
    console.error('[ErrorBoundary] Caught error:', error, info)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="min-h-screen flex items-center justify-center p-8"
          style={{ backgroundColor: '#0d0d10' }}
        >
          <div
            className="max-w-md w-full rounded-[16px] p-8 flex flex-col items-center gap-5 text-center"
            style={{
              backgroundColor: '#0d0d10',
              border: '1px solid #2a2a31',
            }}
          >
            {/* Icon */}
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ backgroundColor: '#7c68ff20', border: '1px solid #7c68ff40' }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7c68ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>

            {/* Text */}
            <div>
              <h2 style={{ color: '#e8e8ea', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
                Something went wrong
              </h2>
              <p style={{ color: '#6c6c74', fontSize: 13, lineHeight: 1.6 }}>
                An unexpected error occurred. You can try again — if the problem persists, please refresh the page.
              </p>
              {this.state.error && (
                <p style={{ color: '#44444b', fontSize: 11, marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {this.state.error.message}
                </p>
              )}
            </div>

            {/* Retry button */}
            <button
              onClick={this.handleRetry}
              style={{
                backgroundColor: '#7c68ff',
                color: '#ffffff',
                border: 'none',
                borderRadius: 10,
                padding: '10px 28px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 2px 12px rgba(124,104,255,0.4)',
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
