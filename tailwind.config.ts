import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Mission Control design tokens
        mc: {
          bg: '#0b0b0c',
          surface: '#16161a',
          surface2: '#1b1b20',
          surface3: '#202028',
          border: '#2a2a31',
          'border-subtle': '#1f1f25',
          text: '#e8e8ea',
          'text-secondary': '#a0a0a7',
          'text-muted': '#6c6c74',
          brand: '#7c68ff',
          'brand-soft': 'rgba(124,104,255,0.18)',
          blue: '#4c8dff',
          'blue-soft': 'rgba(76,141,255,0.15)',
          green: '#4dcc88',
          'green-soft': 'rgba(77,204,136,0.15)',
          red: '#ff5c6c',
          'red-soft': 'rgba(255,92,108,0.15)',
          amber: '#f4a942',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
      },
      boxShadow: {
        card: '0 8px 24px rgba(0,0,0,0.35)',
        glow: '0 0 0 1px rgba(76,141,255,0.4), 0 0 12px rgba(76,141,255,0.15)',
        'glow-brand': '0 0 0 1px rgba(124,104,255,0.4), 0 0 12px rgba(124,104,255,0.15)',
        'glow-green': '0 0 0 1px rgba(77,204,136,0.3), 0 0 10px rgba(77,204,136,0.12)',
      },
    },
  },
  plugins: [],
}
export default config
