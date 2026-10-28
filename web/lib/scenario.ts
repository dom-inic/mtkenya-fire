import type { HourWeather } from "./engine";
import type { Weather } from "./data";

export type WeatherMode = "forecast" | "worst" | "september" | "custom";

export interface Custom {
  windKmh: number;
  windFrom: number;
  rh: number;
}

export interface WeatherSeries {
  start: string; // local EAT "YYYY-MM-DDTHH:00" of hour 0
  hours: HourWeather[];
  note: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Current hour in EAT (UTC+3), formatted like the data timestamps. */
export function nowEat(): string {
  const d = new Date(Date.now() + 3 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`;
}

/** Live forecast for the ignition point from Open-Meteo (no key), starting this hour. */
export async function forecast(lat: number, lon: number, elevation: number, hours: number): Promise<WeatherSeries> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    elevation: String(Math.round(elevation)),
    hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation",
    wind_speed_unit: "kmh",
    timezone: "Africa/Nairobi",
    forecast_days: String(Math.min(Math.ceil(hours / 24) + 1, 7)),
  }).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Forecast unavailable (${r.status})`);
  const j = await r.json();
  const now = nowEat();
  const i0 = Math.max(j.hourly.time.indexOf(now), 0);
  const out: HourWeather[] = [];
  let rain = 0;
  for (let i = i0; i < j.hourly.time.length && out.length < hours; i++) {
    out.push({
      wind_kmh: j.hourly.wind_speed_10m[i],
      wind_from: j.hourly.wind_direction_10m[i],
      rh: j.hourly.relative_humidity_2m[i],
      rain_mm: j.hourly.precipitation[i],
      temp_c: j.hourly.temperature_2m[i],
    });
    rain += j.hourly.precipitation[i];
  }
  return { start: j.hourly.time[i0], hours: out, note: `Open-Meteo forecast from ${j.hourly.time[i0].replace("T", " ")} EAT · ${rain.toFixed(1)} mm rain expected` };
}

/** Bad dry-season day: dry, windy afternoons, humid still nights. */
export function worstCase(startHour: number, hours: number, windFrom = 75): WeatherSeries {
  const out: HourWeather[] = [];
  for (let h = 0; h < hours; h++) {
    const hod = (startHour + h) % 24;
    const day = Math.max(Math.sin((Math.PI * (hod - 7)) / 12), 0); // 0 at night, 1 at 13:00
    out.push({ wind_kmh: 10 + 22 * day, wind_from: windFrom, rh: 70 - 50 * day, rain_mm: 0, temp_c: 6 + 12 * day });
  }
  return { start: `2026-09-04T${pad(startHour)}:00`, hours: out, note: "Worst case: dry-season day, gusty easterlies, humidity down to 20% at midday" };
}

export function custom(c: Custom, startHour: number, hours: number): WeatherSeries {
  const out: HourWeather[] = Array.from({ length: hours }, () => ({ wind_kmh: c.windKmh, wind_from: c.windFrom, rh: c.rh, rain_mm: 0 }));
  return { start: `2026-09-04T${pad(startHour)}:00`, hours: out, note: `Custom: ${c.windKmh} km/h from ${c.windFrom}°, humidity ${c.rh}% (constant)` };
}

/** The September 2026 weather (ERA5), starting 4 Sep at the chosen hour. */
export function september(series: Weather[], startHour: number, hours: number): WeatherSeries {
  const i0 = series.findIndex((w) => w.time === `2026-09-04T${pad(startHour)}:00`);
  const out = series.slice(Math.max(i0, 0), Math.max(i0, 0) + hours).map((w) => ({ wind_kmh: w.wind_kmh, wind_from: w.wind_from, rh: w.rh, rain_mm: w.rain_mm, temp_c: w.temp_c }));
  while (out.length < hours) out.push(out[out.length - 1]);
  return { start: series[Math.max(i0, 0)].time, hours: out, note: "Weather of 4 Sep 2026 onward (ERA5), the day the fire ran" };
}
