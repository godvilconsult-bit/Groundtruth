-- Development seed: one Tanga ward.
--
-- ============================== READ THIS ==============================
-- The geometry below is an APPROXIMATE, HAND-DRAWN RECTANGLE. It is a
-- development fixture and nothing more. It is not authoritative, it is not
-- surveyed, and it must never reach production or any customer.
--
-- `is_authoritative = false` is what enforces that: production work assignment
-- requires authoritative areas. Authoritative ward geometry must be obtained from
-- NBS / TAMISEMI, together with its licence terms, before first real collection in
-- Tanga. See RISKS.md R-005.
-- =======================================================================
--
-- Idempotent: safe to re-run against an existing development database.

BEGIN;

-- Tanga Region
INSERT INTO reference.admin_area
  (id, code, name_en, name_sw, level, parent_id, geom, provenance, source, is_authoritative)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'TZ-25',
  'Tanga',
  'Tanga',
  'REGION',
  NULL,
  ST_Multi(
    ST_GeomFromText(
      'POLYGON((38.80 -5.30, 39.35 -5.30, 39.35 -4.80, 38.80 -4.80, 38.80 -5.30))',
      4326
    )
  ),
  'PUBLIC_DOMAIN',
  'DEVELOPMENT FIXTURE — approximate, not authoritative',
  false
)
ON CONFLICT (id) DO NOTHING;

-- Tanga City Council
INSERT INTO reference.admin_area
  (id, code, name_en, name_sw, level, parent_id, geom, provenance, source, is_authoritative)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'TZ-25-01',
  'Tanga City',
  'Jiji la Tanga',
  'DISTRICT',
  '00000000-0000-4000-8000-000000000001',
  ST_Multi(
    ST_GeomFromText(
      'POLYGON((39.03 -5.14, 39.18 -5.14, 39.18 -5.01, 39.03 -5.01, 39.03 -5.14))',
      4326
    )
  ),
  'PUBLIC_DOMAIN',
  'DEVELOPMENT FIXTURE — approximate, not authoritative',
  false
)
ON CONFLICT (id) DO NOTHING;

-- Chumbageni ward, central Tanga. Roughly 1.7 km x 1.4 km around -5.068, 39.098.
INSERT INTO reference.admin_area
  (id, code, name_en, name_sw, level, parent_id, geom, provenance, source, is_authoritative)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  'TZ-25-01-CHU',
  'Chumbageni',
  'Chumbageni',
  'WARD',
  '00000000-0000-4000-8000-000000000002',
  ST_Multi(
    ST_GeomFromText(
      'POLYGON((39.0900 -5.0750, 39.1055 -5.0750, 39.1055 -5.0620, 39.0900 -5.0620, 39.0900 -5.0750))',
      4326
    )
  ),
  'PUBLIC_DOMAIN',
  'DEVELOPMENT FIXTURE — approximate, not authoritative',
  false
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Sanity check, printed on seed:
--   SELECT name_en, level, is_authoritative,
--          round(ST_Area(geom::geography) / 1e6, 2) AS area_km2
--   FROM reference.admin_area ORDER BY level DESC;
