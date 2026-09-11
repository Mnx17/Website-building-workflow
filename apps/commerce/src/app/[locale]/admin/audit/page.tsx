import { getSql } from '@/lib/db';
import { auditTrail } from '@/lib/repositories/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin-only. Answers "who changed this, and when". */
export default async function AdminAudit() {
  const rows = await auditTrail(getSql(), { limit: 200 });

  return (
    <>
      <h1>Audit trail</h1>
      <section className="card">
        <p className="card__hint">
          Append-only; UPDATE and DELETE are blocked at the database level.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{row.actor_user_id?.slice(0, 8) ?? '—'}</td>
                <td>{row.action}</td>
                <td>{row.entity}</td>
                <td>{row.entity_id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
