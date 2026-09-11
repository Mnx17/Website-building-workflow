import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getSql } from '@/lib/db';
import { AuthError, requireSession, type Session } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin shell.
 *
 * The role check happens here AND in every API route. That is not redundancy
 * for its own sake: this layout decides what to render, the routes decide what
 * may be changed, and RLS decides what the database will actually hand over.
 * A gap in any one of the three is caught by the others.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  let session: Session | null = null;
  let problem: string | null = null;

  try {
    const requestHeaders = await headers();
    session = await requireSession(getSql(), new Request('http://internal/admin', {
      headers: requestHeaders,
    }));
  } catch (error) {
    problem = error instanceof AuthError ? error.message : 'UNAVAILABLE';
  }

  if (!session) {
    return (
      <main className="admin admin--locked">
        <h1>Admin</h1>
        <p className="admin__locked-reason">
          {problem === 'AUTH_NOT_CONFIGURED'
            ? 'Authentication is not configured on this deployment. Set SUPABASE_JWT_SECRET.'
            : problem === 'NOT_STAFF'
              ? 'This account is signed in but is not a staff member.'
              : 'Sign in with a staff account to continue.'}
        </p>
        <p className="admin__locked-code">{problem}</p>
      </main>
    );
  }

  const nav = [
    { href: `/${locale}/admin`, label: 'Dashboard' },
    { href: `/${locale}/admin/inventory`, label: 'Inventory' },
    ...(session.role === 'admin'
      ? [{ href: `/${locale}/admin/audit`, label: 'Audit trail' }]
      : []),
  ];

  return (
    <div className="admin">
      <header className="admin__bar">
        <strong>Admin</strong>
        <nav className="admin__nav">
          {nav.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="admin__role" title={session.email ?? session.userId}>
          {session.role}
        </span>
      </header>
      <main className="admin__body">{children}</main>
    </div>
  );
}
