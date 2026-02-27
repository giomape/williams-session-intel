import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        williamsBlue: "#005AFF",
        williamsNavy: "#001E3C",
        williamsCyan: "#00B5FF",
        appBg: "#0B1220",
        surface: "#111827"
      },
      boxShadow: {
        panel: "0 10px 35px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06)",
        glowBlue: "0 0 26px rgba(0,90,255,0.35)"
      },
      borderColor: {
        subtle: "rgba(255,255,255,0.08)"
      }
    }
  },
  plugins: []
};

export default config;
