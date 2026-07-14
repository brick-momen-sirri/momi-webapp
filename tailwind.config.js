/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
      },
      boxShadow: {
        panel: "0 16px 40px rgba(28, 25, 23, 0.08)",
        card: "0 10px 30px rgba(28, 25, 23, 0.07)",
      },
      colors: {
        ink: "#27241f",
        mist: "#f5f3ee",
        line: "#e7e2d8",
        accent: "#11b8a5",
        ember: "#ff6b35",
      },
    },
  },
  plugins: [],
};
