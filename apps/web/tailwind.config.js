/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        cinzel: ["Cinzel", "serif"],
        playfair: ["Playfair Display", "serif"],
      },
      colors: {
        gold: {
          100: "#fff5d4",
          300: "#ffd67a",
          500: "#d6a84f",
          700: "#8f6a1c",
        },
      },
      boxShadow: {
        glow: "0 0 30px rgba(214,168,79,0.35)",
      },
      backgroundImage: {
        table:
          "radial-gradient(1200px 700px at 10% 10%, rgba(255,221,138,.11), transparent 55%), radial-gradient(900px 600px at 90% 20%, rgba(214,168,79,.10), transparent 55%), radial-gradient(900px 600px at 50% 95%, rgba(6,182,212,.06), transparent 60%), linear-gradient(180deg, #070707, #0c0c0c)",
      },
    },
  },
  plugins: [],
};
