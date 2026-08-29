import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Replacing (not extending) colors removes Tailwind's default palette.
    // `danger` is the only non-grayscale token and is reserved for errors and
    // destructive actions. Components must never use arbitrary color values.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ink: '#000000',
      charcoal: '#111111',
      muted: '#4a4a4a',
      line: '#e5e5e5',
      canvas: '#ffffff',
      danger: '#b91c1c',
    },
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      maxWidth: {
        content: '80rem',
      },
    },
  },
  plugins: [],
} satisfies Config
