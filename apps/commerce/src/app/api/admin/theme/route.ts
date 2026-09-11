import { z } from 'zod';
import { getSql } from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { createEntity, updateEntity } from '@/lib/repositories/admin';
import { jsonResponse, readJson } from '@/lib/http';
import { errorResponse } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Fonts are restricted to a whitelist with genuine Arabic coverage.
 *
 * Most Latin display faces silently fall back for Arabic glyphs, which wrecks
 * half the storefront while looking fine to whoever picked the font.
 */
const ARABIC_CAPABLE_FONTS = [
  'Tajawal',
  'IBM Plex Sans Arabic',
  'Noto Sans Arabic',
  'Cairo',
  'Almarai',
] as const;

const themeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  logo_url: z.string().url().nullable().optional(),
  primary_color: z.string().regex(HEX),
  secondary_color: z.string().regex(HEX),
  font_family: z.enum(ARABIC_CAPABLE_FONTS),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    await requireRole(sql, request, ['admin', 'editor', 'fulfillment']);

    const rows = await sql`
      select id, name, logo_url, primary_color, secondary_color, font_family,
             is_active, updated_at
        from themes order by updated_at desc
    `;
    return jsonResponse({ rows, fonts: ARABIC_CAPABLE_FONTS });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    const session = await requireRole(sql, request, ['admin']);

    const parsed = themeSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return jsonResponse({ error: 'VALIDATION', issues: parsed.error.issues }, { status: 400 });
    }

    const row = await createEntity(sql, 'themes', parsed.data, session.userId);
    return jsonResponse({ row }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  activate: z.boolean().optional(),
  fields: themeSchema.partial().optional(),
});

/**
 * PATCH — edit and/or activate.
 *
 * Activation goes through `activate_theme()`: `themes_single_active` is a
 * partial unique index, so clearing the old flag and setting the new one in
 * two statements races with itself.
 */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    const session = await requireRole(sql, request, ['admin']);

    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return jsonResponse({ error: 'VALIDATION', issues: parsed.error.issues }, { status: 400 });
    }

    if (parsed.data.fields && Object.keys(parsed.data.fields).length > 0) {
      await updateEntity(sql, 'themes', parsed.data.id, parsed.data.fields, session.userId);
    }

    if (parsed.data.activate) {
      // The actor is passed explicitly: this connection is the service role,
      // so auth.uid() inside the function would be null.
      await sql`select activate_theme(${parsed.data.id}, ${session.userId})`;
    }

    const [row] = await sql`select * from themes where id = ${parsed.data.id}`;
    if (!row) return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });

    return jsonResponse({ row });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}
