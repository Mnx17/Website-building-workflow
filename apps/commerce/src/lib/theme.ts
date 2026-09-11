import type postgres from 'postgres';

export type Theme = {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  font_family: string;
};

export const FALLBACK_THEME: Theme = {
  id: 'fallback',
  name: 'Default',
  logo_url: null,
  primary_color: '#1F3B2C',
  secondary_color: '#E8B84B',
  font_family: 'Tajawal',
};

/**
 * Reads the active theme.
 *
 * Returns the fallback rather than throwing if the database is unreachable or
 * no theme is active: an unstyled storefront still sells, a 500 does not.
 */
export async function loadActiveTheme(sql: postgres.ISql): Promise<Theme> {
  try {
    const [row] = await sql<Theme[]>`
      select id, name, logo_url, primary_color, secondary_color, font_family
        from themes where is_active
    `;
    return row ?? FALLBACK_THEME;
  } catch (error) {
    console.error('[theme] falling back to default', error);
    return FALLBACK_THEME;
  }
}

/**
 * Renders the theme as CSS custom properties on :root.
 *
 * Emitted server-side in the layout so there is no flash of unthemed content
 * and no client JS involved. Colours are re-validated here even though the
 * column has a CHECK constraint — this string goes into a <style> tag, and a
 * value that reached the database another way must not become an injection.
 */
export function themeStyleSheet(theme: Theme): string {
  const hex = /^#[0-9A-Fa-f]{6}$/;
  const primary = hex.test(theme.primary_color)
    ? theme.primary_color
    : FALLBACK_THEME.primary_color;
  const secondary = hex.test(theme.secondary_color)
    ? theme.secondary_color
    : FALLBACK_THEME.secondary_color;

  // Font family is whitelisted at the API boundary; quote and strip anyway.
  const font = theme.font_family.replace(/[^A-Za-z0-9 \-]/g, '') || FALLBACK_THEME.font_family;

  return `:root{--brand-primary:${primary};--brand-secondary:${secondary};--brand-font:'${font}';}`;
}
