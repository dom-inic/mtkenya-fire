import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "mapbox-gl/dist/mapbox-gl.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Mount Kenya Fire Analysis · Sept 2026",
  description:
    "Replay of the September 2026 Mount Kenya moorland fire: Sentinel-2 burn scar, satellite hotspots, a calibrated spread model and a simulated drone fleet.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
