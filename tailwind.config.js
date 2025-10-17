/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      colors: {
        mystic: {
          50: "#f6edff",
          100: "#ebe0ff",
          200: "#d8c5ff",
          300: "#bea2ff",
          400: "#a179ff",
          500: "#8b5cf6",
          600: "#723ee0",
          700: "#5b2fc2",
          800: "#462794",
          900: "#331c6b",
        },
        midnight: "#0b1120",
        aurora: "#60a5fa",
        ember: "#f97316",
        verdant: "#34d399",
      },
      backgroundImage: {
        "mystic-overlay":
          "radial-gradient(circle at 10% 10%, rgba(139, 92, 246, 0.55), transparent 55%), radial-gradient(circle at 80% 0%, rgba(56, 189, 248, 0.35), transparent 45%), linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(15, 23, 42, 0.8))",
        "mystic-grid":
          "linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px), linear-gradient(0deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px)",
      },
      boxShadow: {
        mystic: "0 40px 80px -40px rgba(56, 189, 248, 0.45)",
      },
      borderRadius: {
        xl: "1.25rem",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
}
