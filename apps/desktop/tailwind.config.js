/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#07070d", 900: "#0c0c16", 850: "#11111d", 800: "#171726", 700: "#22223a", 600: "#30304d" },
        accent: { DEFAULT: "#7c6cff", soft: "#a79dff", pink: "#e04ccf" },
      },
      fontFamily: { sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      boxShadow: { focus: "0 0 0 3px #fff, 0 12px 40px -8px rgba(124,108,255,.65)" },
    },
  },
  plugins: [],
};
