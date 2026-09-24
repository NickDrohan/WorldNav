import { EARTH_RADIUS_KM } from "../geo/coords";
import type { BoundingBox, ZoomTier } from "./types";

const DEG = Math.PI / 180;

/**
 * Axis-aligned bounding box around a center point that fully contains the
 * given radius. Longitude degrees shrink with latitude, hence the cos(lat)
 * correction. Clamped to valid lat/lon ranges.
 */
export function radiusToBBox(
  lat: number,
  lon: number,
  radiusKm: number,
): BoundingBox {
  const latDelta = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos(lat * DEG), 1e-6);
  const lonDelta = latDelta / cosLat;
  return {
    minLat: clamp(lat - latDelta, -90, 90),
    maxLat: clamp(lat + latDelta, -90, 90),
    minLon: wrapLon(lon - lonDelta),
    maxLon: wrapLon(lon + lonDelta),
  };
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Standard geohash encoder. Precision auto-scales with the area radius so the
 * hash is a meaningful tile key (tighter zoom → longer hash).
 */
export function geohashEncode(
  lat: number,
  lon: number,
  precision = precisionForRadius(0),
): string {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) {
        ch = (ch << 1) | 1;
        lonLo = mid;
      } else {
        ch = ch << 1;
        lonHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch = ch << 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += GEOHASH_BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Geohash length appropriate for an area of the given radius. */
export function precisionForRadius(radiusKm: number): number {
  if (radiusKm <= 0) return 6;
  if (radiusKm > 2500) return 2;
  if (radiusKm > 600) return 3;
  if (radiusKm > 80) return 4;
  if (radiusKm > 10) return 5;
  if (radiusKm > 1) return 7;
  return 8;
}

/** Bucket the viewport span into a semantic zoom tier. */
export function zoomTierForSpan(viewportSpanKm: number): ZoomTier {
  if (viewportSpanKm > 4000) return "orbital";
  if (viewportSpanKm > 400) return "regional";
  if (viewportSpanKm > 25) return "metro";
  return "street";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function wrapLon(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}
